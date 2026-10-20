package controlplane

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

func TestControlRegistrationRequiresCurrentAccountCoreAndCandidateSupport(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong-account", "missing-capability", "missing-fence"} {
		t.Run(scenario, func(t *testing.T) {
			core, user, device := protocol.NewNonce(), protocol.NewID(), protocol.NewID()
			fence := protocol.RegistrationFence{ServerEpoch: protocol.NewNonce(), SubscriptionID: protocol.NewNonce(), CoreInstanceID: core}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/heartbeat" {
					json.NewEncoder(w).Encode(map[string]any{"deviceId": device, "at": time.Now().Unix()})
					return
				}
				connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.ControlSubprotocol}})
				if err != nil {
					return
				}
				defer connection.CloseNow()
				_, body, err := connection.Read(r.Context())
				var hello protocol.ControlHello
				if err != nil || protocol.DecodeControl(body, &hello) != nil || hello.UserID != user || hello.CoreInstanceID != core || hello.Version != 2 || !protocol.HasCapability(hello.Capabilities, protocol.CapabilityCandidate) {
					t.Error("client registration changed explicit scope")
					return
				}
				ready := protocol.ControlReady{Version: 2, Type: "ready", DeviceID: device, UserID: user, Registration: fence, Capabilities: []string{protocol.CapabilityCandidate}}
				if scenario == "wrong-account" {
					ready.UserID = protocol.NewID()
				}
				if scenario == "missing-capability" {
					ready.Capabilities = []string{}
				}
				body, _ = json.Marshal(ready)
				if scenario == "missing-fence" {
					body = []byte(strings.Replace(string(body), `"subscriptionId":"`+fence.SubscriptionID+`",`, "", 1))
				}
				connection.Write(r.Context(), websocket.MessageText, body)
				for {
					if _, _, err := connection.Read(r.Context()); err != nil {
						return
					}
				}
			}))
			server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
			server.StartTLS()
			defer server.Close()
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			client, err := New(Endpoints{HTTPSOrigin: server.URL, WSSURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/signals", STUNAddress: "127.0.0.1:3478"}, roots)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.SetAccount(user)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			signals, err := client.SubscribeControl(ctx, device, core)
			if scenario != "valid" {
				if err == nil || err.Error() != "p2p.protocol_mismatch" {
					t.Fatalf("%s admitted: %v", scenario, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer signals.Close()
			if actual, err := signals.Registration(); err != nil || actual != fence {
				t.Fatal("registration fence did not round trip", actual, err)
			}
		})
	}
}
