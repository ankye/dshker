package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

const signalHealthDeviceID = "a10000000001"

// Exercise the production HTTP client and WebSocket framing over verified TLS.
// Only the remote endpoint decides whether it answers a Ping or admits presence.
type signalHealthServer struct {
	client        *Client
	ctx           context.Context
	cancel        context.CancelFunc
	connection    chan *websocket.Conn
	finished      chan struct{}
	pings         chan struct{}
	messages      chan protocol.Signal
	pong          atomic.Bool
	heartbeats    atomic.Int32
	httpCode      atomic.Value
	initialEvents atomic.Int32
	readyClose    atomic.Value
}

func newSignalHealthServer(t *testing.T) *signalHealthServer {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	server := &signalHealthServer{
		ctx: ctx, cancel: cancel, connection: make(chan *websocket.Conn, 1),
		finished: make(chan struct{}), pings: make(chan struct{}, 64), messages: make(chan protocol.Signal, 64),
	}
	server.pong.Store(true)
	server.httpCode.Store("")
	server.readyClose.Store("")
	server.client = testClient(t, http.HandlerFunc(server.serve))
	t.Cleanup(cancel)
	return server
}

func (server *signalHealthServer) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/heartbeat" {
		server.heartbeats.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if code := server.httpCode.Load().(string); code != "" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
			return
		}
		_ = json.NewEncoder(w).Encode(struct {
			DeviceID string `json:"deviceId"`
			At       int64  `json:"at"`
		}{signalHealthDeviceID, time.Now().Unix()})
		return
	}
	if r.URL.Path != "/v1/signals" {
		http.NotFound(w, r)
		return
	}
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"dshker.signal.v1"},
		OnPingReceived: func(context.Context, []byte) bool {
			select {
			case server.pings <- struct{}{}:
			case <-server.ctx.Done():
			}
			return server.pong.Load()
		},
	})
	if err != nil {
		return
	}
	defer close(server.finished)
	defer connection.CloseNow()
	server.connection <- connection
	if reason := server.readyClose.Load().(string); reason != "" {
		go func() { _ = connection.Close(websocket.StatusPolicyViolation, reason) }()
		_, _, _ = connection.Read(server.ctx)
		return
	}
	ready, _ := json.Marshal(struct {
		Type     string `json:"type"`
		Version  int    `json:"version"`
		DeviceID string `json:"deviceId"`
	}{"ready", protocol.Version, signalHealthDeviceID})
	if connection.Write(server.ctx, websocket.MessageText, ready) != nil {
		return
	}
	for index := range server.initialEvents.Load() {
		data, _ := json.Marshal(struct {
			Type     string `json:"type"`
			PairID   string `json:"pairId"`
			Revision uint64 `json:"revision"`
		}{"revoked", "b20000000002", uint64(index)})
		if connection.Write(server.ctx, websocket.MessageText, data) != nil {
			return
		}
	}
	for {
		kind, data, err := connection.Read(server.ctx)
		if err != nil || kind != websocket.MessageText {
			return
		}
		var signal protocol.Signal
		if json.Unmarshal(data, &signal) != nil {
			return
		}
		select {
		case server.messages <- signal:
		case <-server.ctx.Done():
			return
		}
	}
}

func requireSignalHealthEvent[T any](t *testing.T, source <-chan T, timeout time.Duration) T {
	t.Helper()
	select {
	case value := <-source:
		return value
	case <-time.After(timeout):
		t.Fatalf("signal health event did not arrive within %s", timeout)
		var zero T
		return zero
	}
}

func subscribeHealthySignals(t *testing.T, server *signalHealthServer) *Signals {
	t.Helper()
	signals, err := server.client.Subscribe(context.Background(), signalHealthDeviceID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(signals.Close)
	requireSignalHealthEvent(t, server.pings, time.Second)
	if server.heartbeats.Load() != 1 {
		t.Fatal("Subscribe returned before exactly one admitted HTTPS heartbeat and WebSocket Pong")
	}
	return signals
}

func TestSignalsIdleWebSocketRemainsHealthy(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	connection := requireSignalHealthEvent(t, server.connection, time.Second)
	requireSignalHealthEvent(t, server.pings, signalHeartbeatInterval+2*time.Second)
	if server.heartbeats.Load() != 2 || signals.Err() != nil {
		t.Fatalf("idle subscription lost health: heartbeats=%d cause=%v", server.heartbeats.Load(), signals.Err())
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"revoked","pairId":"b20000000002","revision":7}`)); err != nil {
		t.Fatal(err)
	}
	event := requireSignalHealthEvent(t, signals.Events(), time.Second)
	if event.Type != "revoked" || event.PairID != "b20000000002" || event.Revision != 7 {
		t.Fatalf("idle Ping/Pong replaced or corrupted the signalling event: %+v", event)
	}
}

func TestSignalsMissingPongEndsSubscriptionWithHTTPSHealthy(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	server.pong.Store(false)
	requireSignalHealthEvent(t, server.pings, signalHeartbeatInterval+2*time.Second)
	requireSignalHealthEvent(t, signals.Done(), signalPongTimeout+2*time.Second)
	signals.Close()
	var failure *signalHealthError
	if !errors.As(signals.Err(), &failure) || failure.channel != "websocket" || failure.code != "p2p.server_unavailable" || !errors.Is(failure, context.DeadlineExceeded) {
		t.Fatalf("missing Pong did not preserve the WebSocket deadline cause: %v", signals.Err())
	}
	if server.heartbeats.Load() != 2 || server.httpCode.Load().(string) != "" {
		t.Fatal("WebSocket failure was not detected independently of successful HTTPS presence")
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
	if _, open := <-signals.Events(); open {
		t.Fatal("failed WebSocket left the signalling event source open")
	}
}

func TestSignalsInitialMissingPongRefusesSubscription(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	server.pong.Store(false)
	started := time.Now()
	signals, err := server.client.Subscribe(context.Background(), signalHealthDeviceID)
	var failure *signalHealthError
	if signals != nil || !errors.As(err, &failure) || failure.channel != "websocket" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Subscribe admitted a WebSocket with no Pong: signals=%v error=%v", signals != nil, err)
	}
	if time.Since(started) > signalPongTimeout+2*time.Second || server.heartbeats.Load() != 1 {
		t.Fatal("initial WebSocket health failure exceeded its deadline or skipped HTTPS admission")
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsCloseJoinsHealthAndConcurrentWrites(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	server.pong.Store(false)
	requireSignalHealthEvent(t, server.pings, signalHeartbeatInterval+2*time.Second)
	const writers = 16
	results := make(chan error, writers)
	var sent sync.WaitGroup
	for range writers {
		sent.Add(1)
		go func() {
			defer sent.Done()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			results <- signals.Send(ctx, protocol.Signal{Version: protocol.Version, Type: "offer", AttemptID: "c30000000003"})
		}()
	}
	message := requireSignalHealthEvent(t, server.messages, time.Second)
	if message.Type != "offer" || message.AttemptID != "c30000000003" || message.Version != protocol.Version {
		t.Fatalf("concurrent control and application writes corrupted the frame: %+v", message)
	}
	closed := make(chan struct{})
	go func() { signals.Close(); close(closed) }()
	requireSignalHealthEvent(t, closed, time.Second)
	sent.Wait()
	close(results)
	for err := range results {
		if err != nil && err.Error() != "p2p.server_unavailable" {
			t.Fatalf("concurrent Send returned an untyped error: %v", err)
		}
	}
	if !errors.Is(signals.Err(), context.Canceled) {
		t.Fatalf("explicit Close lost its cancellation cause: %v", signals.Err())
	}
	requireSignalHealthEvent(t, signals.finished, time.Second)
	requireSignalHealthEvent(t, signals.healthDone, time.Second)
	requireSignalHealthEvent(t, server.finished, time.Second)
	signals.Close()
}

func TestSignalsHTTPHeartbeatRefusalIsPreserved(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	server.httpCode.Store("p2p.device_unauthorized")
	signals, err := server.client.Subscribe(context.Background(), signalHealthDeviceID)
	var failure *signalHealthError
	if signals != nil || !errors.As(err, &failure) || failure.channel != "https" || err.Error() != "p2p.device_unauthorized" {
		t.Fatalf("HTTPS admission refusal was replaced by a WebSocket/network error: %v", err)
	}
	if server.heartbeats.Load() != 1 || len(server.pings) != 0 {
		t.Fatal("refused HTTPS admission continued into a WebSocket health check")
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsPeriodicHTTPFailureEndsSubscription(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	server.httpCode.Store("p2p.device_revoked")
	requireSignalHealthEvent(t, signals.Done(), signalHeartbeatInterval+2*time.Second)
	signals.Close()
	var failure *signalHealthError
	if !errors.As(signals.Err(), &failure) || failure.channel != "https" || failure.code != "p2p.device_revoked" {
		t.Fatalf("periodic HTTPS refusal was not retained: %v", signals.Err())
	}
	if server.heartbeats.Load() != 2 || len(server.pings) != 0 {
		t.Fatal("HTTP failure did not stop before the next WebSocket health check")
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsSupersededReasonSurvivesCleanup(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	connection := requireSignalHealthEvent(t, server.connection, time.Second)
	if err := connection.Close(websocket.StatusPolicyViolation, SignalSuperseded); err != nil {
		t.Fatal(err)
	}
	requireSignalHealthEvent(t, signals.Done(), time.Second)
	signals.Close()
	if !signals.Superseded() || signals.Err() == nil || signals.Err().Error() != SignalSuperseded {
		t.Fatalf("coordinator supersession was overwritten by cleanup: %v", signals.Err())
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsInitialBurstRefusesWithSignalLimit(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	server.initialEvents.Store(33)
	server.pong.Store(false)
	result := make(chan error, 1)
	go func() {
		signals, err := server.client.Subscribe(context.Background(), signalHealthDeviceID)
		if signals != nil {
			signals.Close()
			result <- errors.New("initial event overflow returned an admitted subscription")
			return
		}
		result <- err
	}()
	err := requireSignalHealthEvent(t, result, time.Second)
	if err == nil || err.Error() != "p2p.signal_limit" {
		t.Fatalf("initial burst was misclassified as WebSocket health loss: %v", err)
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsSlowConsumerEndsWithSignalLimit(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	connection := requireSignalHealthEvent(t, server.connection, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for index := range 32 {
		data, _ := json.Marshal(struct {
			Type     string `json:"type"`
			PairID   string `json:"pairId"`
			Revision uint64 `json:"revision"`
		}{"revoked", "b20000000002", uint64(index)})
		if err := connection.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	// The following Pong proves all earlier ordered event frames reached the
	// client's reader, which still processes control frames with a full queue.
	if err := connection.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if len(signals.events) != 32 || signals.Err() != nil {
		t.Fatal("a full event queue blocked Pong or terminated before exceeding its bound")
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"revoked","pairId":"b20000000002","revision":32}`)); err != nil {
		t.Fatal(err)
	}
	requireSignalHealthEvent(t, signals.Done(), time.Second)
	if signals.Err() == nil || signals.Err().Error() != "p2p.signal_limit" {
		t.Fatalf("slow consumer was misclassified as WebSocket health loss: %v", signals.Err())
	}
	for index := range 32 {
		event := requireSignalHealthEvent(t, signals.Events(), time.Second)
		if event.Type != "revoked" || event.PairID != "b20000000002" || event.Revision != uint64(index) {
			t.Fatalf("bounded queue dropped or replaced an admitted event: %+v", event)
		}
	}
	if _, open := <-signals.Events(); open {
		t.Fatal("overflow silently continued the signalling subscription")
	}
	signals.Close()
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsSupersededWhilePongPendingPublishesFinalReason(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	connection := requireSignalHealthEvent(t, server.connection, time.Second)
	server.pong.Store(false)
	requireSignalHealthEvent(t, server.pings, signalHeartbeatInterval+2*time.Second)
	if err := connection.Close(websocket.StatusPolicyViolation, SignalSuperseded); err != nil {
		t.Fatal(err)
	}
	requireSignalHealthEvent(t, signals.Done(), time.Second)
	// Inspect at the supervisor's notification boundary, before Close joins health.
	if !signals.Superseded() || signals.Err() == nil || signals.Err().Error() != SignalSuperseded {
		t.Fatalf("Done published before the supersession reason was final: %v", signals.Err())
	}
	signals.Close()
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsInitialSupersededWhilePongPending(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	server.pong.Store(false)
	result := make(chan error, 1)
	go func() {
		signals, err := server.client.Subscribe(context.Background(), signalHealthDeviceID)
		if signals != nil {
			signals.Close()
			result <- errors.New("superseded initial check returned an admitted subscription")
			return
		}
		result <- err
	}()
	connection := requireSignalHealthEvent(t, server.connection, time.Second)
	requireSignalHealthEvent(t, server.pings, time.Second)
	if err := connection.Close(websocket.StatusPolicyViolation, SignalSuperseded); err != nil {
		t.Fatal(err)
	}
	err := requireSignalHealthEvent(t, result, time.Second)
	if err == nil || err.Error() != SignalSuperseded {
		t.Fatalf("initial health failure replaced the coordinator supersession: %v", err)
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsReadFailurePreservesTypedCause(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	signals := subscribeHealthySignals(t, server)
	connection := requireSignalHealthEvent(t, server.connection, time.Second)
	if err := connection.CloseNow(); err != nil {
		t.Fatal(err)
	}
	requireSignalHealthEvent(t, signals.Done(), time.Second)
	var failure *signalHealthError
	if !errors.As(signals.Err(), &failure) || failure.channel != "websocket" || failure.code != "p2p.server_unavailable" || failure.cause == nil || errors.Is(failure, context.Canceled) {
		t.Fatalf("remote socket loss was reported as owner cancellation: %v", signals.Err())
	}
	original := signals.Err()
	signals.Close()
	if signals.Err() != original {
		t.Fatal("cleanup replaced the first specific read failure")
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}

func TestSignalsMalformedMessagePreservesProtocolCause(t *testing.T) {
	t.Parallel()
	for _, message := range []struct {
		name string
		kind websocket.MessageType
		data string
		code string
	}{
		{"invalid_json", websocket.MessageText, "{", "p2p.protocol_mismatch"},
		{"binary", websocket.MessageBinary, "binary", "p2p.protocol_mismatch"},
		{"invalid_event", websocket.MessageText, `{"type":"revoked","pairId":false,"revision":7}`, "p2p.invalid_fields"},
	} {
		t.Run(message.name, func(t *testing.T) {
			t.Parallel()
			server := newSignalHealthServer(t)
			signals := subscribeHealthySignals(t, server)
			connection := requireSignalHealthEvent(t, server.connection, time.Second)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := connection.Write(ctx, message.kind, []byte(message.data)); err != nil {
				t.Fatal(err)
			}
			requireSignalHealthEvent(t, signals.Done(), time.Second)
			if signals.Err() == nil || signals.Err().Error() != message.code || errors.Is(signals.Err(), context.Canceled) {
				t.Fatalf("malformed WebSocket message lost its protocol refusal: %v", signals.Err())
			}
			signals.Close()
			requireSignalHealthEvent(t, server.finished, time.Second)
		})
	}
}

func TestSignalsSupersededBeforeReadyPreservesRefusal(t *testing.T) {
	t.Parallel()
	server := newSignalHealthServer(t)
	server.readyClose.Store(SignalSuperseded)
	signals, err := server.client.Subscribe(server.ctx, signalHealthDeviceID)
	if signals != nil || err == nil || err.Error() != SignalSuperseded {
		t.Fatalf("supersession before ready lost the coordinator refusal: %v", err)
	}
	if server.heartbeats.Load() != 0 || len(server.pings) != 0 {
		t.Fatal("supersession before ready proceeded into health admission")
	}
	requireSignalHealthEvent(t, server.finished, time.Second)
}
