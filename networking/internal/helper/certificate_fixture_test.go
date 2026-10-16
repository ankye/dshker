package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

type certificateFixture struct {
	t                                                                  *testing.T
	mu                                                                 sync.Mutex
	host                                                               *Host
	account                                                            *account
	store                                                              *memoryStore
	private                                                            ed25519.PrivateKey
	caKey                                                              ed25519.PrivateKey
	ca                                                                 *x509.Certificate
	original                                                           controlplane.Device
	current                                                            controlplane.Device
	networkID                                                          string
	queries, renewals, recoveries, grants, subscriptions, runtimeCalls int
	queryCode, grantCode                                               string
	lostReply                                                          bool
	afterIssue                                                         func()
	queryEntered                                                       chan struct{}
	queryRelease                                                       chan struct{}
}

func newCertificateFixture(t *testing.T, remaining time.Duration) *certificateFixture {
	t.Helper()
	f := &certificateFixture{t: t, networkID: protocol.NewID(), store: newMemoryStore()}
	public, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.caKey = caKey
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "certificate authority"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, NotBefore: time.Now().Add(-365 * 24 * time.Hour), NotAfter: time.Now().Add(365 * 24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, caKey)
	if err != nil {
		t.Fatal(err)
	}
	f.ca, err = x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	f.private, _, err = controlplane.NewDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	f.original = controlplane.Device{DeviceID: protocol.NewID(), UserID: protocol.NewID(), Name: "original computer", PublicKey: f.private.Public().(ed25519.PublicKey)}
	f.original.Certificate = f.sign(time.Now().Add(remaining))
	f.current = f.original
	server := httptest.NewUnstartedServer(http.HandlerFunc(f.serve))
	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(f.ca)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: clientCAs}
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	endpoints := controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals", STUNAddress: "127.0.0.1:3478"}
	base, err := controlplane.New(endpoints, roots)
	if err != nil {
		t.Fatal(err)
	}
	f.host = New(context.Background())
	f.host.SetDeviceKeys(f.store)
	f.host.BindMain(certificateMain{f})
	f.account = &account{host: f.host, base: base, identity: controlplane.Identity{Version: 1, ServiceID: protocol.KeyID(public), PublicKey: public, Certificate: der, HTTPSOrigin: endpoints.HTTPSOrigin, WSSURL: endpoints.WSSURL, STUNAddress: endpoints.STUNAddress}, endpoints: endpoints}
	f.host.accounts[f.account.identity.ServiceID] = f.account
	t.Cleanup(f.host.Close)
	return f
}

func (f *certificateFixture) sign(expiry time.Time) []byte {
	f.t.Helper()
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		f.t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: f.original.DeviceID}, NotBefore: time.Now().Add(-40 * 24 * time.Hour), NotAfter: expiry, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, leaf, f.ca, f.private.Public(), f.caKey)
	if err != nil {
		f.t.Fatal(err)
	}
	return der
}

func (f *certificateFixture) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/signals" {
		f.signals(w, r)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/v1/certificate-query":
		f.queries++
		if len(r.TLS.PeerCertificates) != 0 {
			f.t.Error("certificate readback carried device mTLS")
		}
		var query struct {
			ServiceID string `json:"serviceId"`
			DeviceID  string `json:"deviceId"`
			PublicKey []byte `json:"publicKey"`
			IssuedAt  int64  `json:"issuedAt"`
			Signature string `json:"signature"`
		}
		if json.NewDecoder(r.Body).Decode(&query) != nil {
			f.t.Error("invalid query")
		}
		signature, _ := base64.RawURLEncoding.DecodeString(query.Signature)
		message := "dshker.certificate-query.v1\n" + query.ServiceID + "\n" + query.DeviceID + "\n" + base64.RawURLEncoding.EncodeToString(query.PublicKey) + "\n" + strconv.FormatInt(query.IssuedAt, 10)
		if query.ServiceID != f.account.identity.ServiceID || query.DeviceID != f.original.DeviceID || !bytes.Equal(query.PublicKey, f.original.PublicKey) || !ed25519.Verify(query.PublicKey, []byte(message), signature) {
			f.t.Error("query does not prove the original identity")
		}
		if f.queryEntered != nil {
			select {
			case f.queryEntered <- struct{}{}:
			default:
			}
			f.mu.Unlock()
			select {
			case <-f.queryRelease:
			case <-r.Context().Done():
			}
			f.mu.Lock()
		}
		if f.queryCode != "" {
			f.refuse(w, f.queryCode)
			return
		}
		_ = json.NewEncoder(w).Encode(f.current)
	case "/v1/networks/" + f.networkID + "/enrollment-tokens":
		f.grants++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 64) {
			f.t.Error("wrong user-session token")
		}
		if len(r.TLS.PeerCertificates) != 0 {
			f.t.Error("recovery grant carried device mTLS")
		}
		if f.grantCode != "" {
			f.refuse(w, f.grantCode)
			return
		}
		_ = json.NewEncoder(w).Encode(controlplane.EnrollmentGrant{Token: strings.Repeat("g", 64), NetworkID: f.networkID, ExpiresAt: time.Now().Add(time.Minute).Unix()})
	case "/v1/renew-certificate", "/v1/recover-certificate":
		var request struct {
			DeviceID  string `json:"deviceId"`
			RequestID string `json:"requestId"`
			CSR       string `json:"csr"`
			Token     string `json:"token"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || !protocol.ValidID(request.RequestID) {
			f.t.Error("invalid issuance request")
		}
		block, _ := pem.Decode([]byte(request.CSR))
		if block == nil {
			f.t.Error("missing CSR")
			return
		}
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil || !bytes.Equal(csr.PublicKey.(ed25519.PublicKey), f.original.PublicKey) {
			f.t.Error("issuance replaced original key")
		}
		if r.URL.Path == "/v1/renew-certificate" {
			f.renewals++
			if len(r.TLS.PeerCertificates) != 1 || r.TLS.PeerCertificates[0].Subject.CommonName != f.original.DeviceID {
				f.t.Error("renewal did not authenticate device")
			}
		} else {
			f.recoveries++
			if len(r.TLS.PeerCertificates) != 0 || request.DeviceID != f.original.DeviceID || request.Token != strings.Repeat("g", 64) {
				f.t.Error("recovery credential contract changed")
			}
		}
		f.current.Certificate = f.sign(time.Now().Add(30 * 24 * time.Hour))
		if f.afterIssue != nil {
			f.afterIssue()
		}
		if f.lostReply {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				f.t.Error(err)
				return
			}
			_ = connection.Close()
			return
		}
		_ = json.NewEncoder(w).Encode(struct {
			Certificate []byte `json:"certificate"`
		}{f.current.Certificate})
	case "/v1/heartbeat":
		_ = json.NewEncoder(w).Encode(map[string]any{"deviceId": f.original.DeviceID, "at": time.Now().Unix()})
	case "/v1/pairs":
		_ = json.NewEncoder(w).Encode([]controlplane.Pair{})
	default:
		f.t.Errorf("unexpected certificate workflow request %s", r.URL.Path)
		f.refuse(w, "p2p.invalid_request")
	}
}

func (f *certificateFixture) refuse(w http.ResponseWriter, code string) {
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
}

func (f *certificateFixture) signals(w http.ResponseWriter, r *http.Request) {
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"dshker.signal.v1"}})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	f.mu.Lock()
	f.subscriptions++
	f.mu.Unlock()
	data, _ := json.Marshal(map[string]any{"type": "ready", "version": 1, "deviceId": f.original.DeviceID})
	_ = connection.Write(r.Context(), websocket.MessageText, data)
	for {
		if _, _, err := connection.Read(r.Context()); err != nil {
			return
		}
	}
}

type certificateMain struct{ f *certificateFixture }

func (owner certificateMain) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	if strings.HasPrefix(method, "runtime.") {
		owner.f.mu.Lock()
		owner.f.runtimeCalls++
		owner.f.mu.Unlock()
	}
	return json.RawMessage(`{}`), nil
}

func (f *certificateFixture) call(device controlplane.Device, networkID, token string) (certificateResult, error) {
	data := map[string]any{"device": device, "privateKey": f.private}
	if networkID != "" {
		data["networkId"] = networkID
	}
	if token != "" {
		data["token"] = token
	}
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": data})
	result, err := f.host.Handle(context.Background(), "device.certificate", payload)
	if err != nil {
		return certificateResult{}, err
	}
	return result.(certificateResult), nil
}
