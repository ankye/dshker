package helper

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestCertificateRecoveryEndpointRefusalsStopBeforeReadback(t *testing.T) {
	for _, test := range []struct {
		name, code, want string
		status           int
		disconnect       bool
	}{
		{name: "binding-unauthorized", code: "p2p.binding_unauthorized", want: "p2p.certificate_recovery_forbidden", status: http.StatusForbidden},
		{name: "identity-mismatch", code: "p2p.identity_mismatch", want: "p2p.identity_mismatch", status: http.StatusBadRequest},
		{name: "invalid-grant", code: "p2p.invalid_enrollment_token", want: "p2p.certificate_recovery_forbidden", status: http.StatusForbidden},
		{name: "server-unavailable", code: "p2p.server_unavailable", want: "p2p.certificate_sync_failed", status: http.StatusServiceUnavailable},
		{name: "internal-error", code: "p2p.internal_error", want: "p2p.internal_error", status: http.StatusInternalServerError},
		{name: "request-conflict", code: "p2p.request_conflict", want: "p2p.request_conflict", status: http.StatusConflict},
		{name: "disconnected-before-commit", want: "p2p.certificate_sync_failed", disconnect: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newCertificateFixture(t, -time.Hour)
			certificateRecoveryRefusalEndpoint(t, f, test.code, test.status, test.disconnect)
			sessionToken := strings.Repeat("s", 64)
			f.account.rememberToken(sessionToken)
			result, err := f.call(f.original, f.networkID, sessionToken)
			certificateError(t, err, test.want)
			if !reflect.DeepEqual(result, certificateResult{}) {
				t.Fatal("rejected recovery returned a success result")
			}
			f.mu.Lock()
			queries, grants, recoveries := f.queries, f.grants, f.recoveries
			unchanged := reflect.DeepEqual(f.current, f.original)
			f.mu.Unlock()
			if queries != 1 || grants != 1 || recoveries != 1 || !unchanged {
				t.Fatalf("recovery failure continued post-issue readback or changed server state: queries=%d grants=%d recoveries=%d unchanged=%t", queries, grants, recoveries, unchanged)
			}
			assertCertificateRecoveryRefusalState(t, f, sessionToken)
		})
	}
}

func certificateRecoveryRefusalEndpoint(t *testing.T, f *certificateFixture, code string, status int, disconnect bool) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/recover-certificate" {
			f.serve(w, r)
			return
		}
		f.mu.Lock()
		f.recoveries++
		f.mu.Unlock()
		var request struct {
			DeviceID  string `json:"deviceId"`
			RequestID string `json:"requestId"`
			CSR       string `json:"csr"`
			Token     string `json:"token"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || r.Method != http.MethodPost || len(r.TLS.PeerCertificates) != 0 || request.DeviceID != f.original.DeviceID || !protocol.ValidID(request.RequestID) || request.Token != strings.Repeat("g", 64) {
			t.Error("recovery refusal did not receive the original public request contract")
		}
		block, _ := pem.Decode([]byte(request.CSR))
		if block == nil {
			t.Error("recovery refusal received no CSR")
			return
		}
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil {
			t.Error("recovery refusal received an invalid CSR")
			return
		}
		public, ok := csr.PublicKey.(ed25519.PublicKey)
		if !ok || csr.CheckSignature() != nil || !bytes.Equal(public, f.original.PublicKey) {
			t.Error("recovery refusal received a replacement device key")
		}
		if disconnect {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			connection.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"code": code})
	}))
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	endpoints := controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals", STUNAddress: f.account.endpoints.STUNAddress}
	base, err := controlplane.New(endpoints, roots)
	if err != nil {
		t.Fatal(err)
	}
	f.account.base.Close()
	f.account.base, f.account.endpoints = base, endpoints
	f.account.identity.HTTPSOrigin, f.account.identity.WSSURL = endpoints.HTTPSOrigin, endpoints.WSSURL
}

func assertCertificateRecoveryRefusalState(t *testing.T, f *certificateFixture, token string) {
	t.Helper()
	canonical, err := f.host.LoadCredential(f.account.identity.ServiceID)
	if err != nil || canonical.Version != 1 || canonical.ServiceID != f.account.identity.ServiceID || canonical.Endpoints != f.account.endpoints || !bytes.Equal(canonical.ServiceKey, f.account.identity.PublicKey) || !reflect.DeepEqual(canonical.device(), f.original) || !bytes.Equal(canonical.PrivateKey, f.private) {
		t.Fatal("rejected recovery changed original canonical identity", err)
	}
	metadata, err := f.host.loadCertificateMetadata(f.account.identity.ServiceID)
	if err != nil || metadata.Version != 1 || metadata.NetworkID != f.networkID || !protocol.ValidID(metadata.PendingRequestID) {
		t.Fatal("rejected recovery lost the original scope or durable request identity", err)
	}
	f.account.directory.mu.Lock()
	storedToken := f.account.directory.token
	f.account.directory.mu.Unlock()
	if storedToken != token || f.account.client != nil || f.account.manager != nil || f.renewals != 0 || f.runtimeCalls != 0 {
		t.Fatal("recovery refusal changed login, activated the device, renewed or requested DSH")
	}
}
