package helper

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

func TestRemovedAccountRefusesLateManagementAndRestore(t *testing.T) {
	for _, method := range []string{"user.login", "device.restore"} {
		t.Run(method, func(t *testing.T) {
			host := New(context.Background())
			t.Cleanup(host.Close)
			owner := &account{host: host}
			host.accounts["aaaaaaaaaaaa"] = owner
			// The handler captured owner before ForgetService acquired its lock;
			// it enters the account-owned operation only after removal completes.
			host.ForgetService("aaaaaaaaaaaa")
			owner.mu.Lock()
			defer owner.mu.Unlock()
			var err error
			if method == "device.restore" {
				_, err = host.restore(context.Background(), owner, json.RawMessage(`{}`))
			} else {
				_, err = host.manage(context.Background(), owner, method, json.RawMessage(`{"username":"test","password":"test"}`))
			}
			if err == nil || err.Error() != "p2p.service_unconfigured" {
				t.Fatalf("late %s on a removed owner = %v, want p2p.service_unconfigured", method, err)
			}
		})
	}
}

func TestLateConfigurationCannotRecreateRemovedService(t *testing.T) {
	f := newCertificateFixture(t, 30*24*time.Hour)
	entered, release := make(chan struct{}), make(chan struct{})
	identity := f.account.identity
	var endpoints controlplane.Endpoints
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var challenge struct {
			Nonce string `json:"nonce"`
		}
		if request.URL.Path != "/v1/identity" || json.NewDecoder(request.Body).Decode(&challenge) != nil {
			http.NotFound(writer, request)
			return
		}
		answer := identity
		answer.Nonce, answer.HTTPSOrigin, answer.WSSURL, answer.STUNAddress = challenge.Nonce, endpoints.HTTPSOrigin, endpoints.WSSURL, endpoints.STUNAddress
		signed, _ := json.Marshal([]any{"dshker.service.v1", answer.Version, answer.ServiceID, answer.PublicKey, answer.Certificate, answer.Nonce, answer.HTTPSOrigin, answer.WSSURL, answer.STUNAddress})
		answer.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.caKey, signed))
		close(entered)
		select {
		case <-release:
		case <-request.Context().Done():
			return
		}
		json.NewEncoder(writer).Encode(answer)
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	defer close(release)
	endpoints = controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals", STUNAddress: "127.0.0.1:3478"}
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	f.host.SetRoots(roots)
	payload, _ := json.Marshal(struct {
		Endpoints controlplane.Endpoints `json:"endpoints"`
		PinnedKey []byte                 `json:"pinnedKey"`
		Telemetry controlplane.Telemetry `json:"telemetry"`
	}{endpoints, identity.PublicKey, controlplane.Telemetry{}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := f.host.configure(ctx, payload); result <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("configuration never reached identity admission")
	}
	f.host.ForgetService(identity.ServiceID)
	// Unblock the signed response after removal, without creating a new call.
	select {
	case release <- struct{}{}:
	case <-ctx.Done():
		t.Fatal("identity response could not resume")
	}
	if err := <-result; err == nil || err.Error() != "p2p.service_unconfigured" {
		t.Fatalf("late configure revived removed service: %v", err)
	}
	if f.host.accounts[identity.ServiceID] != nil {
		t.Fatal("late configuration recreated a removed account owner")
	}
}
