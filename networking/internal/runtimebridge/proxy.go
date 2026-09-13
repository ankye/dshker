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

// OpenBrowserEndpoint opens a browser gateway that survives reconnection.
//
// The loopback listener and therefore the URL belong to the endpoint's whole
// life, not to one session: a tab left open on the address keeps working after
// the direct path is rebuilt, because the session is swapped underneath
// instead of the port being reallocated.
func OpenBrowserEndpoint(ctx context.Context, attachment *Endpoint) (*Gateway, error) {
	binding, err := attachment.target()
	if err != nil {
		return nil, err
	}
	target, err := binding.Endpoint()
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("p2p.listener_unavailable")
	}
	local := &url.URL{Scheme: "http", Host: listener.Addr().String(), Path: "/", RawQuery: target.RawQuery}
	transport := &http.Transport{Proxy: nil, MaxConnsPerHost: 64, MaxIdleConnsPerHost: 8, ResponseHeaderTimeout: 70 * time.Second, IdleConnTimeout: 60 * time.Second,
		DialContext: func(requestCtx context.Context, network, address string) (net.Conn, error) {
			// The destination is re-read per dial: a rebuilt session may point at a
			// restarted runtime on a different loopback port.
			current, err := attachment.target()
			if err != nil {
				return nil, err
			}
			allowed, err := current.Endpoint()
			if err != nil {
				return nil, err
			}
			if network != "tcp" || address != allowed.Host {
				return nil, errors.New("p2p.destination_rejected")
			}
			if err := requestCtx.Err(); err != nil {
				return nil, err
			}
			stream, err := attachment.open()
			if err != nil {
				return nil, err
			}
			return peer.NewConn(ctx, stream), nil
		},
	}
	// The local address is fixed for the gateway's life; the peer's runtime is
	// resolved per request so a restart behind a reconnect is followed.
	fixedLocal := func() (*url.URL, error) { return local, nil }
	destination := func() (*url.URL, error) {
		current, err := attachment.target()
		if err != nil {
			return nil, err
		}
		return current.Endpoint()
	}
	gateway := serve(ctx, listener, fixedLocal, destination, transport)
	gateway.URL = local.String()
	// The endpoint owns the address for its whole life, so a reconnect reports the
	// same URL instead of the peer's loopback address.
	attachment.setLocalURL(gateway.URL)
	attachment.mu.Lock()
	// Closing the endpoint has to release the port: an endpoint that ends while
	// its listener keeps answering leaves a URL reachable for a pair the user
	// just revoked.
	attachment.onClose = func() { gateway.Close() }
	// Dropping a dead session's connections is the gateway's job, so the endpoint
	// does it automatically on every detach and replace.
	attachment.onDetach = gateway.DropConnections
	attachment.mu.Unlock()
	return gateway, nil
}

// ServeTargetEndpoint answers connections for as long as the pair is meant to
// be reachable, independent of any one session. The peer.Listener underneath
// is what makes this possible: it waits for the next mux instead of ending
// the http.Server the moment a session drops, so this side never has to
// restart serving after a reconnect.
func ServeTargetEndpoint(ctx context.Context, attachment *Endpoint) (*Gateway, error) {
	binding, err := attachment.target()
	if err != nil {
		return nil, err
	}
	// The address is validated here but resolved per request later, so a
	// restarted runtime's new port and token are followed rather than pinned.
	if _, err := binding.Endpoint(); err != nil {
		return nil, err
	}
	mux, err := attachment.currentMux()
	if err != nil {
		return nil, err
	}
	listener := peer.NewListener(ctx, mux)
	attachment.mu.Lock()
	attachment.onReplace = listener.Replace
	attachment.onClose = func() { listener.Close() }
	attachment.mu.Unlock()
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, MaxConnsPerHost: 64, MaxIdleConnsPerHost: 8, ResponseHeaderTimeout: 70 * time.Second, IdleConnTimeout: 60 * time.Second}
	// Requests arrive with the peer runtime's authority because the other side
	// forwards them verbatim; both addresses are resolved per request so a
	// restarted runtime's new port and token are honored.
	resolve := func() (*url.URL, error) {
		current, err := attachment.target()
		if err != nil {
			return nil, err
		}
		return current.Endpoint()
	}
	return serve(ctx, listener, resolve, resolve, transport), nil
}

// serve runs the reverse proxy for one gateway. Both addresses are resolved per
// request rather than captured once: the peer's runtime can restart behind a
// reconnect and announce a new loopback port and token, and a gateway holding
// the old ones would keep forwarding to a runtime that no longer exists.
// resolveDestination returns the peer runtime URL to forward to;
// resolveIncoming returns the address this gateway is being reached on.
func serve(parent context.Context, listener net.Listener, resolveIncoming, resolveDestination func() (*url.URL, error), transport *http.Transport) *Gateway {
	ctx, cancel := context.WithCancel(parent)
	gateway := &Gateway{transport: transport, cancel: cancel, sockets: make(map[net.Conn]struct{}), done: make(chan struct{})}
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(writer, "p2p.stream_failed", http.StatusBadGateway)
		},
		Rewrite: func(request *httputil.ProxyRequest) {
			destination, err := resolveDestination()
			if err != nil {
				return
			}
			target := *destination
			target.RawQuery, target.Path = "", ""
			request.SetURL(&target)
			request.Out.Host = destination.Host
			// The local address is stable by design, so a tab keeps the token it was
			// opened with. The peer's runtime can restart with a new one, so a request
			// that carries a token is forwarded with the *current* token instead — that
			// is what lets an already-open tab recover without the user visiting a new
			// address. A request carrying only the session cookie is left alone, or the
			// token exchange would redirect forever.
			if _, carried := request.In.URL.Query()["token"]; carried && destination.RawQuery != "" {
				request.Out.URL.RawQuery = destination.RawQuery
			}
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
			destination, err := resolveDestination()
			if err != nil {
				return errors.New("p2p.redirect_rejected")
			}
			incoming, err := resolveIncoming()
			if err != nil {
				return errors.New("p2p.redirect_rejected")
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
			incoming, err := resolveIncoming()
			if err != nil || !admit(request, incoming) {
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

// DropConnections ends every connection carried by the session that just died,
// without closing the gateway or releasing its port.
//
// Keeping the listener is the point of a reconnect-surviving gateway, but the
// connections on top of the old session must not be kept: a pooled connection
// would otherwise be reused for the next request and hang or read a truncated
// response instead of failing cleanly and being redialled on the new session.
func (gateway *Gateway) DropConnections() {
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
}

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
