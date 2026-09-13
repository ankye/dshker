package runtimebridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

type hello struct {
	Version           int    `json:"version"`
	Type              string `json:"type"`
	AttemptID         string `json:"attemptId"`
	Generation        uint64 `json:"generation"`
	RuntimeGeneration uint64 `json:"runtimeGeneration"`
	URL               string `json:"url"`
	Error             string `json:"error"`
}

// RuntimeOwner must be implemented by the target main process; it is never a
// caller-provided address or an HTTP endpoint on the coordination server.
type RuntimeOwner func(context.Context, string) (Binding, error)

// Establish negotiates the runtime binding over the transport and attaches
// the resulting mux to attachment.
//
// attachment is nil on a pair's first connection: Establish then creates the
// long-lived Endpoint and, for the initiator, the gateway with it. On every
// later reconnect the caller passes the Endpoint it kept from the first call,
// and Establish only replaces the session inside it — the loopback port (for
// a browser tab) or the http.Server (for ServeTarget) survives untouched, so
// neither the URL nor the listening side needs to change across a rebuild.
//
// sessionCtx ends with one session (its transport, its attempt); gatewayCtx is
// the long-lived context that owns the listener — the manager's lifetime, not
// the session's. Attaching the gateway to sessionCtx would close its port the
// moment the session ended, which is exactly what a stable URL must not do.
func Establish(sessionCtx context.Context, gatewayCtx context.Context, transport *peer.Transport, lease protocol.Lease, initiator bool, owner RuntimeOwner, attachment *Endpoint) (*Gateway, *Endpoint, *peer.Mux, Binding, error) {
	budget, cancel := context.WithTimeout(sessionCtx, 70*time.Second)
	defer cancel()
	request := hello{Version: 1, Type: "runtime.connect", AttemptID: lease.AttemptID, Generation: lease.Generation}
	var binding Binding
	if initiator {
		if err := sendHello(transport, request); err != nil {
			return nil, nil, nil, binding, err
		}
		response, err := readHello(budget, transport, request)
		if err != nil {
			return nil, nil, nil, binding, err
		}
		if response.Type != "runtime.result" || response.Error != "" {
			return nil, nil, nil, binding, errors.New("p2p.runtime_unavailable")
		}
		binding = Binding{Generation: response.RuntimeGeneration, URL: response.URL}
	} else {
		incoming, err := readHello(budget, transport, request)
		if err != nil {
			return nil, nil, nil, binding, err
		}
		if incoming.Type != "runtime.connect" || incoming.RuntimeGeneration != 0 || incoming.URL != "" || incoming.Error != "" {
			return nil, nil, nil, binding, errors.New("p2p.protocol_mismatch")
		}
		if owner == nil {
			return nil, nil, nil, binding, errors.New("p2p.runtime_unavailable")
		}
		// The runtime owner keys its catalog, its pin map and its state projection
		// by the *far* device id — never by the coordinator's attempt key. The
		// lease carries the id the initiator supplied, which is the target's own
		// device id, so on this side lease.PairID names this device and every
		// lookup by it is a miss. Ask about the initiator instead.
		peerDeviceID := lease.ToDeviceID
		if !initiator {
			peerDeviceID = lease.FromDeviceID
		}
		binding, err = owner(budget, peerDeviceID)
		request.Type = "runtime.result"
		if err != nil {
			// Never swallow the reason: a flattened code here is indistinguishable
			// from a genuinely unavailable runtime and hides the real refusal.
			fmt.Fprintf(os.Stderr, "runtime.connect owner refused peer=%s: %v\n", peerDeviceID, err)
			request.Error = "p2p.runtime_unavailable"
			sendHello(transport, request)
			return nil, nil, nil, binding, err
		}
		if _, err = binding.Endpoint(); err != nil {
			return nil, nil, nil, binding, err
		}
		request.RuntimeGeneration, request.URL = binding.Generation, binding.URL
		if err = sendHello(transport, request); err != nil {
			return nil, nil, nil, binding, err
		}
	}
	if _, err := binding.Endpoint(); err != nil {
		return nil, nil, nil, binding, err
	}
	mux, err := peer.NewMux(transport, peer.StreamScope{AttemptID: lease.AttemptID, Generation: lease.Generation, RuntimeGeneration: binding.Generation, Initiator: initiator})
	if err != nil {
		return nil, nil, nil, binding, err
	}
	var gateway *Gateway
	if attachment == nil {
		attachment, err = NewEndpoint(mux, binding)
		if err != nil {
			mux.Close()
			return nil, nil, nil, binding, err
		}
		if initiator {
			gateway, err = OpenBrowserEndpoint(gatewayCtx, attachment)
		} else {
			gateway, err = ServeTargetEndpoint(gatewayCtx, attachment)
		}
		if err != nil {
			attachment.Close()
			mux.Close()
			return nil, nil, nil, binding, err
		}
	} else if err = attachment.Replace(mux, binding); err != nil {
		mux.Close()
		return nil, nil, nil, binding, err
	}
	return gateway, attachment, mux, binding, nil
}

func sendHello(transport *peer.Transport, value hello) error {
	data, err := json.Marshal(value)
	if err != nil {
		return errors.New("p2p.protocol_mismatch")
	}
	return transport.Send(data)
}
func readHello(ctx context.Context, transport *peer.Transport, scope hello) (hello, error) {
	select {
	case <-ctx.Done():
		return hello{}, ctx.Err()
	case <-transport.Done():
		return hello{}, errors.New("p2p.direct_closed")
	case data := <-transport.Messages():
		var value hello
		if protocol.Decode(data, &value) != nil || value.Version != 1 || value.AttemptID != scope.AttemptID || value.Generation != scope.Generation {
			return value, errors.New("p2p.protocol_mismatch")
		}
		return value, nil
	}
}

// Probe proves authenticated HTTP and the actual DSH websocket endpoint before
// readiness. It does not submit a task, retain browser cookies, or stop DSH.
func Probe(parent context.Context, rawURL string) error {
	endpoint, err := url.Parse(rawURL)
	if err != nil {
		return errors.New("p2p.runtime_invalid")
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	jar, _ := cookiejar.New(nil)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Jar: jar, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Host != endpoint.Host || r.URL.Scheme != endpoint.Scheme {
			return errors.New("p2p.redirect_rejected")
		}
		return nil
	}}
	request, _ := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	response, err := client.Do(request)
	if err != nil {
		return errors.New("p2p.runtime_http_failed")
	}
	response.Body.Close()
	if response.StatusCode != 200 || len(jar.Cookies(endpoint)) == 0 {
		return errors.New("p2p.runtime_http_failed")
	}
	headers := http.Header{"Origin": []string{endpoint.Scheme + "://" + endpoint.Host}}
	connection, _, err := websocket.Dial(ctx, "ws://"+endpoint.Host+"/api/remote.mux", &websocket.DialOptions{HTTPClient: client, HTTPHeader: headers})
	if err != nil {
		return errors.New("p2p.runtime_websocket_failed")
	}
	return connection.CloseNow()
}
