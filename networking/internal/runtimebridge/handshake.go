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
}

// RuntimeOwner must be implemented by the target main process; it is never a
// caller-provided address or an HTTP endpoint on the coordination server.
type RuntimeOwner func(context.Context, string) (Binding, error)

func Establish(ctx context.Context, transport *peer.Transport, lease protocol.Lease, initiator bool, owner RuntimeOwner) (*Gateway, *peer.Mux, Binding, error) {
	budget, cancel := context.WithTimeout(ctx, 70*time.Second)
	defer cancel()
	request := hello{Version: 1, Type: "runtime.connect", AttemptID: lease.AttemptID, Generation: lease.Generation}
	var binding Binding
	if initiator {
		if err := sendHello(transport, request); err != nil {
			return nil, nil, binding, err
		}
		response, err := readHello(budget, transport, request)
		if err != nil {
			return nil, nil, binding, err
		}
		if response.Type != "runtime.result" || response.Error != "" {
			return nil, nil, binding, errors.New("p2p.runtime_unavailable")
		}
		binding = Binding{Generation: response.RuntimeGeneration, URL: response.URL}
	} else {
		incoming, err := readHello(budget, transport, request)
		if err != nil {
			return nil, nil, binding, err
		}
		if incoming.Type != "runtime.connect" || incoming.RuntimeGeneration != 0 || incoming.URL != "" || incoming.Error != "" {
			return nil, nil, binding, errors.New("p2p.protocol_mismatch")
		}
		if owner == nil {
			return nil, nil, binding, errors.New("p2p.runtime_unavailable")
		}
		binding, err = owner(budget, lease.PairID)
		request.Type = "runtime.result"
		if err != nil {
			request.Error = "p2p.runtime_unavailable"
			sendHello(transport, request)
			return nil, nil, binding, err
		}
		if _, err = binding.Endpoint(); err != nil {
			return nil, nil, binding, err
		}
		request.RuntimeGeneration, request.URL = binding.Generation, binding.URL
		if err = sendHello(transport, request); err != nil {
			return nil, nil, binding, err
		}
	}
	if _, err := binding.Endpoint(); err != nil {
		return nil, nil, binding, err
	}
	mux, err := peer.NewMux(transport, peer.StreamScope{AttemptID: lease.AttemptID, Generation: lease.Generation, RuntimeGeneration: binding.Generation, Initiator: initiator})
	if err != nil {
		return nil, nil, binding, err
	}
	var gateway *Gateway
	if initiator {
		gateway, err = OpenBrowser(ctx, mux, binding)
	} else {
		gateway, err = ServeTarget(ctx, mux, binding)
	}
	if err != nil {
		mux.Close()
		return nil, nil, binding, err
	}
	return gateway, mux, binding, nil
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
