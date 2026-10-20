package runtimebridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
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

// AttachmentInstaller commits negotiation only while its attempt is current.
type AttachmentInstaller func(*peer.Mux, Binding) (*Gateway, *Endpoint, error)

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
func Establish(sessionCtx context.Context, transport *peer.Transport, lease protocol.Lease, initiator, requestWorkbench, resumeWorkbench bool, owners WorkbenchOwners, install AttachmentInstaller) (*Gateway, *Endpoint, *peer.Mux, Binding, string, error) {
	budget, cancel := context.WithTimeout(sessionCtx, 70*time.Second)
	defer cancel()
	binding, refusal, err := negotiateWorkbench(budget, transport, lease, initiator, requestWorkbench, resumeWorkbench, owners)
	if err != nil {
		return nil, nil, nil, binding, refusal, err
	}
	mux, err := peer.NewMux(transport, peer.StreamScope{AttemptID: lease.AttemptID, Generation: lease.Generation, RuntimeGeneration: binding.Generation, Initiator: initiator})
	if err != nil {
		return nil, nil, nil, binding, refusal, err
	}
	gateway, attachment, err := install(mux, binding)
	if err != nil {
		mux.Close()
		return nil, nil, nil, binding, refusal, err
	}
	return gateway, attachment, mux, binding, refusal, nil
}
func peerDeviceID(lease protocol.Lease, initiator bool) string {
	if initiator {
		return lease.ToDeviceID
	}
	return lease.FromDeviceID
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
