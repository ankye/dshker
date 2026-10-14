package peersession

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

const signallingHealthDevice = "a10000000001"

// The production client and supervisor use real, verified TLS/WebSocket
// connections. The server controls only its own wire behavior, never the
// client's transport, subscription, clock, or retry policy.
type signallingHealthEndpoint struct {
	client     *controlplane.Client
	ctx        context.Context
	cancel     context.CancelFunc
	dials      atomic.Int32
	heartbeats atomic.Int32
	pong       atomic.Bool
	supersede  atomic.Int32
	accepted   chan signallingAcceptedSocket
	pings      chan int32
}

type signallingAcceptedSocket struct {
	index      int32
	connection *websocket.Conn
}

func newSignallingHealthEndpoint(t *testing.T) *signallingHealthEndpoint {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	endpoint := &signallingHealthEndpoint{
		ctx: ctx, cancel: cancel,
		accepted: make(chan signallingAcceptedSocket, 8), pings: make(chan int32, 32),
	}
	endpoint.pong.Store(true)
	server := httptest.NewUnstartedServer(http.HandlerFunc(endpoint.serve))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	var err error
	endpoint.client, err = controlplane.New(controlplane.Endpoints{
		HTTPSOrigin: server.URL, WSSURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/signals",
		STUNAddress: strings.TrimPrefix(server.URL, "https://"),
	}, roots)
	if err != nil {
		cancel()
		server.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); endpoint.client.Close(); server.Close() })
	return endpoint
}

func (endpoint *signallingHealthEndpoint) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/heartbeat" {
		endpoint.heartbeats.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			DeviceID string `json:"deviceId"`
			At       int64  `json:"at"`
		}{signallingHealthDevice, time.Now().Unix()})
		return
	}
	if r.URL.Path != "/v1/signals" {
		http.NotFound(w, r)
		return
	}
	index := endpoint.dials.Add(1)
	var connection *websocket.Conn
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"dshker.signal.v1"},
		OnPingReceived: func(context.Context, []byte) bool {
			select {
			case endpoint.pings <- index:
			case <-endpoint.ctx.Done():
			}
			if endpoint.supersede.Load() == index {
				go func() {
					_ = connection.Close(websocket.StatusPolicyViolation, controlplane.SignalSuperseded)
				}()
				return false
			}
			return index != 1 || endpoint.pong.Load()
		},
	})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	select {
	case endpoint.accepted <- signallingAcceptedSocket{index: index, connection: connection}:
	case <-endpoint.ctx.Done():
		return
	}
	ready, _ := json.Marshal(struct {
		Type     string `json:"type"`
		Version  int    `json:"version"`
		DeviceID string `json:"deviceId"`
	}{"ready", protocol.Version, signallingHealthDevice})
	if connection.Write(endpoint.ctx, websocket.MessageText, ready) != nil {
		return
	}
	for {
		if _, _, err := connection.Read(endpoint.ctx); err != nil {
			return
		}
	}
}

func awaitSignallingHealth[T any](t *testing.T, source <-chan T, timeout time.Duration) T {
	t.Helper()
	select {
	case value := <-source:
		return value
	case <-time.After(timeout):
		t.Fatalf("signalling health event did not arrive within %s", timeout)
		var zero T
		return zero
	}
}

func TestSignalingInitialHealthSupersededDoesNotRetry(t *testing.T) {
	t.Parallel()
	endpoint := newSignallingHealthEndpoint(t)
	endpoint.supersede.Store(1)
	owner, err := newSignaling(endpoint.ctx, func(ctx context.Context, device string) (subscription, error) {
		return endpoint.client.Subscribe(ctx, device)
	}, signallingHealthDevice, func(subscription) {})
	if owner != nil || err == nil || err.Error() != controlplane.SignalSuperseded {
		t.Fatalf("initial health supersession did not refuse ownership: owner=%v error=%v", owner != nil, err)
	}
	time.Sleep(3 * time.Second)
	if endpoint.dials.Load() != 1 {
		t.Fatal("initial superseded health check started an automatic retry")
	}
}

func TestSignalingReplacementHealthSupersededStopsAutomaticRetry(t *testing.T) {
	t.Parallel()
	endpoint := newSignallingHealthEndpoint(t)
	endpoint.supersede.Store(2)
	managerCtx, cancelManager := context.WithCancel(endpoint.ctx)
	t.Cleanup(cancelManager)
	refused := make(chan error, 1)
	manager := &Manager{ctx: managerCtx, cancel: cancelManager, config: Config{Device: controlplane.Device{DeviceID: signallingHealthDevice}}}
	manager.subscribe = func(ctx context.Context, device string) (subscription, error) {
		active, err := endpoint.client.Subscribe(ctx, device)
		if err != nil {
			refused <- err
		}
		return active, err
	}
	var err error
	manager.signals, err = newSignaling(managerCtx, manager.subscribe, signallingHealthDevice, manager.receive)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.signals.close() })
	first := awaitSignallingHealth(t, endpoint.accepted, time.Second)
	if first.index != 1 {
		t.Fatal("first healthy signalling socket lost its connection identity")
	}
	_ = first.connection.CloseNow()
	err = awaitSignallingHealth(t, refused, 3*time.Second)
	if err.Error() != controlplane.SignalSuperseded {
		t.Fatalf("replacement health refusal lost the explicit superseded code: %v", err)
	}
	time.Sleep(3 * time.Second)
	if endpoint.dials.Load() != 2 || !manager.signals.isDown() {
		t.Fatal("superseded replacement kept redialling or claimed healthy ownership")
	}
	if _, usable := manager.signals.current(); usable {
		t.Fatal("superseded replacement exposed a usable subscription")
	}
	requestCtx, finishRequest := context.WithCancel(context.Background())
	if err := manager.ReconnectSignals(requestCtx); err != nil {
		finishRequest()
		t.Fatalf("explicit reconnect was blocked after superseded automatic replacement: %v", err)
	}
	finishRequest()
	if endpoint.dials.Load() != 3 || manager.signals.isDown() {
		t.Fatal("explicit reconnect did not install exactly one healthy successor")
	}
	active, usable := manager.signals.current()
	if !usable || active.Superseded() {
		t.Fatal("explicit reconnect retained the superseded socket")
	}
	select {
	case <-active.Done():
		t.Fatal("explicit reconnect attached socket ownership to the finished request")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSignalingHealthTimeoutReplacesActualSocket(t *testing.T) {
	t.Parallel()
	endpoint := newSignallingHealthEndpoint(t)
	installed := make(chan subscription, 4)
	events := make(chan controlplane.SignalEvent, 4)
	owner, err := newSignaling(endpoint.ctx, func(ctx context.Context, device string) (subscription, error) {
		return endpoint.client.Subscribe(ctx, device)
	}, signallingHealthDevice, func(active subscription) {
		installed <- active
		for event := range active.Events() {
			events <- event
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.close)
	first := awaitSignallingHealth(t, installed, time.Second)
	firstSocket := awaitSignallingHealth(t, endpoint.accepted, time.Second)
	if firstSocket.index != 1 || awaitSignallingHealth(t, endpoint.pings, time.Second) != 1 {
		t.Fatal("initial signalling socket was not verified by its actual Pong")
	}
	endpoint.pong.Store(false)
	started := time.Now()
	if awaitSignallingHealth(t, endpoint.pings, 12*time.Second) != 1 {
		t.Fatal("periodic health check did not target the original socket")
	}
	awaitSignallingHealth(t, first.Done(), 7*time.Second)
	if failure := first.(*controlplane.Signals).Err(); failure == nil || failure.Error() != "p2p.server_unavailable" {
		t.Fatalf("missing Pong did not preserve the signalling timeout cause: %v", failure)
	}
	if endpoint.heartbeats.Load() < 2 || time.Since(started) < 10*time.Second {
		t.Fatal("signal timeout bypassed real heartbeat cadence or failed with HTTPS presence")
	}
	second := awaitSignallingHealth(t, installed, 3*time.Second)
	secondSocket := awaitSignallingHealth(t, endpoint.accepted, time.Second)
	if first == second || secondSocket.index != 2 || endpoint.dials.Load() != 2 || owner.isDown() {
		t.Fatal("supervisor did not replace the timed-out socket with one healthy successor")
	}
	ctx, cancel := context.WithTimeout(endpoint.ctx, time.Second)
	defer cancel()
	if err := secondSocket.connection.Write(ctx, websocket.MessageText, []byte(`{"type":"revoked","pairId":"b20000000002","revision":7}`)); err != nil {
		t.Fatal(err)
	}
	event := awaitSignallingHealth(t, events, time.Second)
	if event.Type != "revoked" || event.PairID != "b20000000002" || event.Revision != 7 {
		t.Fatalf("recovered signalling event lost its pair identity or revision: %+v", event)
	}
}
