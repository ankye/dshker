package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

func TestControlTelemetryIsJoinedAndCannotDetermineWSSHealth(t *testing.T) {
	device, user, core := protocol.NewID(), protocol.NewID(), protocol.NewNonce()
	fence := protocol.RegistrationFence{ServerEpoch: protocol.NewNonce(), SubscriptionID: protocol.NewNonce(), CoreInstanceID: core}
	entered, release := make(chan heartbeat, 1), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/heartbeat" {
			var body heartbeat
			json.NewDecoder(r.Body).Decode(&body)
			entered <- body
			<-release
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.server_unavailable"})
			return
		}
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.ControlSubprotocol}})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		if _, _, err := connection.Read(r.Context()); err != nil {
			return
		}
		body, _ := json.Marshal(protocol.ControlReady{Version: 2, Type: "ready", DeviceID: device, UserID: user, Registration: fence, Capabilities: []string{protocol.CapabilityCandidate}})
		connection.Write(r.Context(), websocket.MessageText, body)
		for {
			if _, _, err := connection.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	client.SetAccount(user)
	client.SetTelemetry(Telemetry{Version: "test-build", Platform: "darwin", Architecture: "arm64"})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	signals, err := client.SubscribeControl(ctx, device, core)
	if err != nil {
		t.Fatal(err)
	}
	defer signals.Close()
	select {
	case body := <-entered:
		if body.UserID != user || body.Version != "test-build" {
			t.Fatal("telemetry lost explicit selected account/build", body)
		}
	case <-ctx.Done():
		t.Fatal("independent telemetry did not start")
	}
	if err := signals.ping(); err != nil {
		t.Fatal("blocked HTTPS prevented healthy WSS Ping", err)
	}
	once.Do(func() { close(release) })
	if err := signals.ping(); err != nil {
		t.Fatal("telemetry refusal closed the WSS owner", err)
	}
	signals.Close()
	select {
	case <-signals.telemetryDone:
	default:
		t.Fatal("Close did not join telemetry worker")
	}
}

func TestControlRejectsLegacyAttemptInsteadOfDowngrading(t *testing.T) {
	if _, admitted, err := decodeControlEvent([]byte(`{"version":1,"type":"attempt"}`)); err == nil || admitted {
		t.Fatal("v2 admitted a legacy destructive attempt", err)
	}
}
