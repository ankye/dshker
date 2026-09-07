// Package runtimebridge forwards only the explicitly bound, current DSH runtime.
package runtimebridge

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
)

// Binding comes only from the target Launcher runtime owner. URL contains a
// transient credential and must never be logged, persisted, or sent to UI state.
type Binding struct {
	Generation uint64 `json:"generation"`
	URL        string `json:"url"`
}

func (binding Binding) Endpoint() (*url.URL, error) {
	endpoint, err := url.Parse(binding.URL)
	if err != nil || binding.Generation == 0 || endpoint.Scheme != "http" || endpoint.User != nil || endpoint.Fragment != "" || endpoint.Path != "/" {
		return nil, errors.New("p2p.runtime_invalid")
	}
	ip := net.ParseIP(endpoint.Hostname())
	port, err := strconv.Atoi(endpoint.Port())
	query, queryErr := url.ParseQuery(endpoint.RawQuery)
	if ip == nil || !ip.IsLoopback() || err != nil || port < 1 || port > 65535 || queryErr != nil || len(query) != 1 || len(query["token"]) != 1 || query.Get("token") == "" {
		return nil, errors.New("p2p.runtime_invalid")
	}
	return endpoint, nil
}

// Gateway owns one HTTP server and every upgraded socket for one runtime.
// Closing a gateway does not stop the remote DSH process or other peers.
type Gateway struct {
	URL       string
	server    *http.Server
	transport *http.Transport
	cancel    context.CancelFunc
	mu        sync.Mutex
	closed    bool
	sockets   map[net.Conn]struct{}
	done      chan struct{}
	once      sync.Once
}

func ServeTarget(ctx context.Context, mux *peer.Mux, binding Binding) (*Gateway, error) {
	if mux == nil || mux.RuntimeGeneration() != binding.Generation {
		return nil, errors.New("p2p.runtime_generation_mismatch")
	}
	endpoint, err := binding.Endpoint()
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, MaxConnsPerHost: 64, MaxIdleConnsPerHost: 8, ResponseHeaderTimeout: 70 * time.Second, IdleConnTimeout: 60 * time.Second}
	return serve(ctx, peer.NewListener(ctx, mux), endpoint, endpoint, transport), nil
}

func OpenBrowser(ctx context.Context, mux *peer.Mux, binding Binding) (*Gateway, error) {
	if mux == nil || mux.RuntimeGeneration() != binding.Generation {
		return nil, errors.New("p2p.runtime_generation_mismatch")
	}
	endpoint, err := binding.Endpoint()
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("p2p.listener_unavailable")
	}
	local := &url.URL{Scheme: "http", Host: listener.Addr().String(), Path: "/"}
	transport := &http.Transport{Proxy: nil, MaxConnsPerHost: 64, MaxIdleConnsPerHost: 8, ResponseHeaderTimeout: 70 * time.Second, IdleConnTimeout: 60 * time.Second,
		DialContext: func(requestCtx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != endpoint.Host {
				return nil, errors.New("p2p.destination_rejected")
			}
			if err := requestCtx.Err(); err != nil {
				return nil, err
			}
			stream, err := mux.Open()
			if err != nil {
				return nil, err
			}
			return peer.NewConn(ctx, stream), nil
		},
	}
	gateway := serve(ctx, listener, local, endpoint, transport)
	local.RawQuery = endpoint.RawQuery
	gateway.URL = local.String()
	return gateway, nil
}

func serve(parent context.Context, listener net.Listener, incoming, destination *url.URL, transport *http.Transport) *Gateway {
	ctx, cancel := context.WithCancel(parent)
	gateway := &Gateway{transport: transport, cancel: cancel, sockets: make(map[net.Conn]struct{}), done: make(chan struct{})}
	target := *destination
	target.RawQuery, target.Path = "", ""
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(writer, "p2p.stream_failed", http.StatusBadGateway)
		},
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(&target)
			request.Out.Host = destination.Host
			if request.In.Header.Get("Origin") != "" {
				request.Out.Header.Set("Origin", destination.Scheme+"://"+destination.Host)
			}
			request.Out.Header.Del("Forwarded")
		},
		ModifyResponse: func(response *http.Response) error {
			location := response.Header.Get("Location")
			if location == "" {
				return nil
			}
			next, err := url.Parse(location)
			if err != nil {
				return errors.New("p2p.redirect_rejected")
			}
			if next.IsAbs() || next.Host != "" {
				if next.Host != destination.Host || (next.Scheme != "" && next.Scheme != destination.Scheme) {
					return errors.New("p2p.redirect_rejected")
				}
				next.Scheme, next.Host = incoming.Scheme, incoming.Host
				response.Header.Set("Location", next.String())
			}
			return nil
		},
	}
	gateway.server = &http.Server{
		Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if !admit(request, incoming) {
				http.Error(writer, "p2p.destination_rejected", http.StatusForbidden)
				return
			}
			proxy.ServeHTTP(writer, request)
		}),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 * 1024,
		ErrorLog:    log.New(io.Discard, "", 0),
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() {
		defer close(gateway.done)
		gateway.server.Serve(&trackedListener{Listener: listener, owner: gateway})
		cancel()
	}()
	go func() { <-ctx.Done(); gateway.Close() }()
	return gateway
}

func admit(request *http.Request, incoming *url.URL) bool {
	if request.Method == http.MethodConnect || request.Host != incoming.Host || request.URL.IsAbs() || request.URL.Host != "" {
		return false
	}
	origin := request.Header.Values("Origin")
	if len(origin) > 1 || (len(origin) == 1 && origin[0] != incoming.Scheme+"://"+incoming.Host) {
		return false
	}
	if request.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	upgrade := request.Header.Get("Upgrade")
	return upgrade == "" || (strings.EqualFold(upgrade, "websocket") && request.Method == "GET" && request.URL.Path == "/api/remote.mux")
}

func (gateway *Gateway) Close() {
	gateway.once.Do(func() {
		gateway.mu.Lock()
		gateway.closed = true
		gateway.mu.Unlock()
		gateway.cancel()
		gateway.server.Close()
		gateway.transport.CloseIdleConnections()
		gateway.mu.Lock()
		sockets := make([]net.Conn, 0, len(gateway.sockets))
		for socket := range gateway.sockets {
			sockets = append(sockets, socket)
		}
		gateway.mu.Unlock()
		for _, socket := range sockets {
			socket.Close()
		}
	})
}

func (gateway *Gateway) Done() <-chan struct{} { return gateway.done }

type trackedListener struct {
	net.Listener
	owner *Gateway
}
type trackedConn struct {
	net.Conn
	owner *Gateway
	once  sync.Once
}

func (listener *trackedListener) Accept() (net.Conn, error) {
	for {
		conn, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		wrapped := &trackedConn{Conn: conn, owner: listener.owner}
		listener.owner.mu.Lock()
		if listener.owner.closed {
			listener.owner.mu.Unlock()
			conn.Close()
			return nil, net.ErrClosed
		}
		if len(listener.owner.sockets) >= 64 {
			listener.owner.mu.Unlock()
			conn.Close()
			continue
		}
		listener.owner.sockets[wrapped] = struct{}{}
		listener.owner.mu.Unlock()
		return wrapped, nil
	}
}
func (conn *trackedConn) Close() error {
	var err error
	conn.once.Do(func() {
		err = conn.Conn.Close()
		conn.owner.mu.Lock()
		delete(conn.owner.sockets, conn)
		conn.owner.mu.Unlock()
	})
	return err
}
