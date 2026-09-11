package controlplane

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func testClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := New(Endpoints{HTTPSOrigin: server.URL, WSSURL: strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals", STUNAddress: "127.0.0.1:3478"}, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

func TestExplicitEndpointsAndStrictResponses(t *testing.T) {
	valid := Endpoints{HTTPSOrigin: "https://example.test:443", WSSURL: "wss://example.test:443/v1/signals", STUNAddress: "[::1]:3478"}
	if valid.Validate() != nil {
		t.Fatal("explicit valid endpoints rejected")
	}
	for _, change := range []func(*Endpoints){
		func(e *Endpoints) { e.HTTPSOrigin = "http://example.test" }, func(e *Endpoints) { e.HTTPSOrigin += "/" }, func(e *Endpoints) { e.HTTPSOrigin = "https://user@example.test:443" },
		func(e *Endpoints) { e.WSSURL = "wss://other.test/v1/signals" }, func(e *Endpoints) { e.WSSURL += "?token=secret" }, func(e *Endpoints) { e.STUNAddress = "" }, func(e *Endpoints) { e.STUNAddress = "host:0" }, func(e *Endpoints) { e.STUNAddress = "host:65536" }, func(e *Endpoints) { e.STUNAddress = "turn:example.test" },
	} {
		value := valid
		change(&value)
		if value.Validate() == nil {
			t.Fatal("invalid endpoint silently admitted")
		}
	}
	for _, data := range []string{`null`, `[{"userId":"a","username":"b","username":"c"}]`, `[{"userId":"a"}]`, `[{"userId":"a","username":"b","unknown":1}]`, `[] []`} {
		var users []User
		if decodeResponse([]byte(data), &users) == nil {
			t.Fatalf("accepted ambiguous or incomplete response: %s", data)
		}
	}
	var users []User
	if decodeResponse([]byte(`[{"userId":"exact-id","username":"exact-name"}]`), &users) != nil || len(users) != 1 || users[0].UserID != "exact-id" || users[0].Username != "exact-name" {
		t.Fatal("response substituted explicit values")
	}
}

func TestTLSAndRedirectNeverForwardCredentials(t *testing.T) {
	var leaked atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer target.Close()
	client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	if _, err := client.Networks(context.Background(), "test-only-bearer"); err == nil || leaked.Load() != 0 {
		t.Fatal("redirect forwarded credentials")
	}
	untrusted, err := New(client.endpoints, x509.NewCertPool())
	if err != nil {
		t.Fatal(err)
	}
	defer untrusted.Close()
	if _, err = untrusted.Identity(context.Background(), nil); err == nil {
		t.Fatal("untrusted TLS accepted")
	}
}

func TestServiceIdentityNoncePinAndCertificateBinding(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test service"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, ca, ca, public, private)
	if err != nil {
		t.Fatal(err)
	}
	var client *Client
	var corrupt atomic.Bool
	client = testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Nonce string `json:"nonce"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid request")
			return
		}
		value := Identity{Version: 1, ServiceID: protocol.KeyID(public), PublicKey: public, Certificate: der, Nonce: request.Nonce, HTTPSOrigin: client.endpoints.HTTPSOrigin, WSSURL: client.endpoints.WSSURL, STUNAddress: client.endpoints.STUNAddress}
		if corrupt.Load() {
			value.Nonce = protocol.NewID()
		}
		data, _ := json.Marshal([]any{"dshker.service.v1", value.Version, value.ServiceID, value.PublicKey, value.Certificate, value.Nonce, value.HTTPSOrigin, value.WSSURL, value.STUNAddress})
		value.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, data))
		json.NewEncoder(w).Encode(value)
	}))
	identity, err := client.Identity(context.Background(), public)
	if err != nil || identity.ServiceID != protocol.KeyID(public) {
		t.Fatalf("valid signed identity readback failed: %v", err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err = client.Identity(context.Background(), other); err == nil {
		t.Fatal("changed pinned service key accepted")
	}
	corrupt.Store(true)
	if _, err = client.Identity(context.Background(), public); err == nil {
		t.Fatal("wrong response nonce accepted")
	}
	deviceKey, _, err := NewDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	deviceID := protocol.NewID()
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: deviceID}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	cert, err := x509.CreateCertificate(rand.Reader, leaf, ca, deviceKey.Public(), private)
	if err != nil {
		t.Fatal(err)
	}
	device := Device{DeviceID: deviceID, UserID: protocol.NewID(), PublicKey: deviceKey.Public().(ed25519.PublicKey), Certificate: cert, Name: "client"}
	authenticated, err := client.WithDevice(device, deviceKey, identity)
	if err != nil {
		t.Fatal(err)
	}
	authenticated.Close()
	changed := identity
	changed.PublicKey = other
	changed.ServiceID = protocol.KeyID(other)
	if _, err = client.WithDevice(device, deviceKey, changed); err == nil {
		t.Fatal("CA key differs from pinned identity but was accepted")
	}
	device.DeviceID = protocol.NewID()
	if _, err = client.WithDevice(device, deviceKey, identity); err == nil {
		t.Fatal("certificate device ID substituted")
	}
}

func TestTurnCredentialsEndpointAndStrictFields(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/turn-credentials" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"urls":       []string{"turn:127.0.0.1:3478"},
			"username":   "1750000000:device-1",
			"credential": "cGFzcw==",
		})
	})
	client := testClient(t, handler)
	creds, err := client.TurnCredentials(context.Background())
	if err != nil {
		t.Fatalf("TurnCredentials failed: %v", err)
	}
	if len(creds.URLs) != 1 || creds.URLs[0] != "turn:127.0.0.1:3478" {
		t.Fatalf("unexpected urls: %v", creds.URLs)
	}
	if creds.Username != "1750000000:device-1" || creds.Credential != "cGFzcw==" {
		t.Fatalf("unexpected credential: %+v", creds)
	}
}

// TestTurnCredentialsMalformedResponseRefused keeps the client strict: a
// coordinator answer without the required relay fields is a typed refusal,
// never a silent empty relay.
func TestTurnCredentialsMalformedResponseRefused(t *testing.T) {
	client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	if _, err := client.TurnCredentials(context.Background()); err == nil || err.Error() != "p2p.missing_field" {
		t.Fatalf("malformed credential response was not refused strictly: %v", err)
	}
}

func TestPairIdentityRejectsMissingCrossDeviceAndCrossUserFields(t *testing.T) {
	a, _, _ := ed25519.GenerateKey(rand.Reader)
	b, _, _ := ed25519.GenerateKey(rand.Reader)
	userID, pairID, first, second := protocol.NewID(), protocol.NewID(), protocol.NewID(), protocol.NewID()
	valid := PairIdentity{Pair: Pair{PairID: pairID, NetworkID: protocol.NewID(), Initiator: first, Target: second, State: "active", Revision: 1}, Initiator: PairDeviceIdentity{DeviceID: first, UserID: userID, PublicKey: a, Name: "A", Presence: "online"}, Target: PairDeviceIdentity{DeviceID: second, UserID: userID, PublicKey: b, Name: "B", Presence: "offline"}}
	for name, mutate := range map[string]func(*PairIdentity){"valid": func(*PairIdentity) {}, "missing-user": func(p *PairIdentity) { p.Target.UserID = ""; p.Initiator.UserID = "" }, "cross-user": func(p *PairIdentity) { p.Target.UserID = protocol.NewID() }, "same-key": func(p *PairIdentity) { p.Target.PublicKey = a }, "missing-network": func(p *PairIdentity) { p.Pair.NetworkID = "" }, "unknown-presence": func(p *PairIdentity) { p.Target.Presence = "ready" }, "revoked": func(p *PairIdentity) { p.Pair.State = "revoked" }} {
		t.Run(name, func(t *testing.T) {
			value := valid
			mutate(&value)
			client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(value) }))
			client.deviceID = first
			got, err := client.PairIdentity(context.Background(), pairID)
			if name == "valid" {
				if err != nil || got.Pair != valid.Pair || got.Target.DeviceID != second {
					t.Fatal("exact pair identity readback failed")
				}
				client.deviceID = protocol.NewID()
				if _, err = client.PairIdentity(context.Background(), pairID); err == nil {
					t.Fatal("third-party identity accepted")
				}
			} else if err == nil {
				t.Fatal("missing or cross-scope identity accepted")
			}
		})
	}
}
