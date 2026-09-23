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
	// Capabilities is what the sender's build supports. It is the extension point
	// for this contract: a later build adds a name and older peers ignore it.
	Capabilities []string `json:"capabilities"`
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
	request := hello{Version: 1, Type: "runtime.connect", AttemptID: lease.AttemptID, Generation: lease.Generation, Capabilities: protocol.PeerCapabilities()}
	var binding Binding
	// Whether the peer's build keeps a link alive with no workbench on it. Assumed
	// true for the initiator path, where the answer arrives with the reply instead.
	peerKeepsWorkbenchlessLinks := true
	if initiator {
		if err := sendHello(transport, request); err != nil {
			return nil, nil, nil, binding, err
		}
		response, err := readHello(budget, transport, request)
		if err != nil {
			return nil, nil, nil, binding, err
		}
		if response.Type != "runtime.result" {
			return nil, nil, nil, binding, errors.New("p2p.protocol_mismatch")
		}
		if response.Error != "" {
			// The peer has no workbench to offer. That is a fact about the far
			// machine, not a failure of this connection, so the reason is recorded
			// and the link is still established: the two computers remain connected
			// and whatever else the connection carries keeps working. Only a code
			// the protocol admits is reported; anything else collapses to the
			// generic one so a library sentence cannot masquerade as a refusal.
			code := "p2p.runtime_unavailable"
			if named, ok := protocol.Refusal(errors.New(response.Error)); ok {
				code = named
			}
			fmt.Fprintf(os.Stderr, "runtime.connect peer has no workbench: %s (connection kept)\n", code)
			binding = Binding{}
		} else {
			binding = Binding{Generation: response.RuntimeGeneration, URL: response.URL}
		}
	} else {
		incoming, err := readHello(budget, transport, request)
		if err != nil {
			return nil, nil, nil, binding, err
		}
		if incoming.Type != "runtime.connect" || incoming.RuntimeGeneration != 0 || incoming.URL != "" || incoming.Error != "" {
			return nil, nil, nil, binding, errors.New("p2p.protocol_mismatch")
		}
		if !protocol.ValidCapabilities(incoming.Capabilities) {
			return nil, nil, nil, binding, errors.New("p2p.protocol_mismatch")
		}
		// A peer that cannot keep a connection without a workbench will drop this one
		// the moment we answer that we have none, whatever we do here. Recording it
		// makes that outcome readable from this side instead of appearing as two logs
		// disagreeing about whether the connection succeeded.
		peerKeepsWorkbenchlessLinks = protocol.HasCapability(incoming.Capabilities, protocol.CapabilityOptionalWorkbench)
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
			// A workbench that will not start is not a broken connection.
			//
			// This used to end the session: the pair was told the named refusal and
			// the transport was torn down, so a local problem on one machine — an
			// unresolved pnpm, a dependency tree the platform could not traverse —
			// destroyed a link that had already been negotiated successfully, and
			// the reconnect that followed destroyed the next one too. Connection
			// maintenance belongs to this daemon; a workbench is one optional thing
			// carried over a connection, not the reason it exists. The reason is
			// still reported and still reaches the peer, but the link survives it.
			code := "p2p.runtime_unavailable"
			if named, ok := protocol.Refusal(err); ok {
				code = named
			}
			kept := "connection kept, no workbench"
			if !peerKeepsWorkbenchlessLinks {
				// Naming this is the whole point of advertising capabilities. The link is
				// kept on this side, the peer's older build will close it anyway, and
				// without this line the two machines' logs simply disagree about whether
				// the connection succeeded — which is exactly how a mixed-build pair
				// used to look while neither side could say why.
				kept = "connection kept here, but this peer's build closes links without a workbench — upgrade it"
			}
			fmt.Fprintf(os.Stderr, "runtime.connect owner refused peer=%s: %v (%s)\n", peerDeviceID, err, kept)
			request.Error = code
			binding, err = Binding{}, nil
		} else if _, invalid := binding.Endpoint(); invalid != nil {
			// An owner that answers with something unusable is the same case: report
			// it and carry on without a tunnel rather than dropping the link.
			fmt.Fprintf(os.Stderr, "runtime.connect owner answered an unusable binding peer=%s: %v (connection kept, no workbench)\n", peerDeviceID, invalid)
			request.Error, binding = "p2p.runtime_invalid", Binding{}
		} else {
			request.RuntimeGeneration, request.URL = binding.Generation, binding.URL
		}
		if err = sendHello(transport, request); err != nil {
			return nil, nil, nil, binding, err
		}
	}
	mux, err := peer.NewMux(transport, peer.StreamScope{AttemptID: lease.AttemptID, Generation: lease.Generation, RuntimeGeneration: binding.Generation, Initiator: initiator})
	if err != nil {
		return nil, nil, nil, binding, err
	}
	// Without a workbench there is nothing to proxy, so no endpoint and no gateway
	// are built — but the transport and its mux are established and returned, and
	// that is what being connected means. Attaching a workbench later is the job of
	// the next Establish for this pair, which replaces the session in place.
	if _, usable := binding.Endpoint(); usable != nil {
		// A pair that had a workbench before keeps its attachment, and with it the
		// stable address a tab may already be showing. That attachment must not be
		// left pointing at the session it held previously: this reconnect replaces
		// it, and the old mux is about to die with the old session. Detaching drops
		// the dead session's pooled connections and tells the listening side the
		// address currently serves nothing, instead of leaving an address that
		// answers every request with a failure while the UI reports ready.
		if attachment != nil {
			attachment.Detach(attachment.CurrentMux())
		}
		return nil, attachment, mux, binding, nil
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
