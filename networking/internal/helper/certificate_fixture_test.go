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

	"github.com/ankye/dshker/networking/internal/catalog"
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
	grantSessionToken                                                  string
	loginSession                                                       *controlplane.UserSession
	authRequests                                                       []accountTransportRequest
	authReplyGate                                                      func(*http.Request)
	authReplyCode                                                      string
	logoutRevoked                                                      bool
	lostReply                                                          bool
	afterIssue                                                         func()
	queryEntered                                                       chan struct{}
	queryRelease                                                       chan struct{}
	selectedUserID                                                     string
	scopedIdentity                                                     *controlplane.PairIdentity
	scopedIdentities                                                   []controlplane.PairIdentity
	networks                                                           []controlplane.Network
	networkDevices                                                     []controlplane.DeviceEntry
	identityCode                                                       string
	hellos                                                             []protocol.ControlHello
	identityRequests                                                   []protocol.PairIdentityRequest
	identityEntered                                                    chan struct{}
	identityRelease                                                    <-chan struct{}
	signalAttempts                                                     []time.Time
	rejectSignalAttempt                                                int
	serviceCode                                                        string
	serviceQueries                                                     int
	serviceEntered                                                     chan struct{}
	serviceRelease                                                     <-chan struct{}
	observeHTTP                                                        func(http.ResponseWriter, *http.Request, http.HandlerFunc)
	signalReadyGate                                                    func()
	signalClosed                                                       chan struct{}
}

func newCertificateFixture(t *testing.T, remaining time.Duration) *certificateFixture {
	t.Helper()
	f := &certificateFixture{t: t, networkID: protocol.NewID(), store: newMemoryStore(), grantSessionToken: strings.Repeat("s", 64), networkDevices: []controlplane.DeviceEntry{}}
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
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if observe := f.httpObserver(); observe != nil {
			observe(w, r, f.serve)
			return
		}
		f.serve(w, r)
	}))
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
	f.host.SetRoots(roots)
	f.host.SetDeviceKeys(f.store)
	f.host.BindMain(certificateMain{f})
	f.account = &account{host: f.host, base: base, httpPhase: accountHTTPSetup, identity: controlplane.Identity{Version: 1, ServiceID: protocol.KeyID(public), PublicKey: public, Certificate: der, HTTPSOrigin: endpoints.HTTPSOrigin, WSSURL: endpoints.WSSURL, STUNAddress: endpoints.STUNAddress}, endpoints: endpoints}
	f.host.accounts[f.account.identity.ServiceID] = f.account
	catalogStore, err := catalog.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := catalogStore.Enable()
	if err != nil {
		t.Fatal(err)
	}
	record := enabled.Record
	record.Services = []catalog.Service{{ServiceID: f.account.identity.ServiceID, DisplayName: "certificate test", HTTPSOrigin: endpoints.HTTPSOrigin, WSSURL: endpoints.WSSURL, STUNAddress: endpoints.STUNAddress, PublicKey: base64.StdEncoding.EncodeToString(public), Certificate: base64.StdEncoding.EncodeToString(der)}}
	if _, err := catalogStore.Commit(enabled.Revision, record); err != nil {
		t.Fatal(err)
	}
	f.host.SetCatalog(catalogStore)
	t.Cleanup(f.host.Close)
	return f
}

func (f *certificateFixture) httpObserver() func(http.ResponseWriter, *http.Request, http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.observeHTTP
}

func (f *certificateFixture) setHTTPObserver(observe func(http.ResponseWriter, *http.Request, http.HandlerFunc)) {
	f.mu.Lock()
	f.observeHTTP = observe
	f.mu.Unlock()
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
	if r.URL.Path == "/v1/login" || r.URL.Path == "/v1/user" || r.URL.Path == "/v1/logout" {
		observed := accountTransportRequest{method: r.Method, path: r.URL.Path, bearer: r.Header.Get("Authorization") == "Bearer "+f.grantSessionToken}
		if len(r.TLS.PeerCertificates) != 0 {
			observed.deviceID = r.TLS.PeerCertificates[0].Subject.CommonName
			observed.verified = len(r.TLS.VerifiedChains) != 0
		}
		f.authRequests = append(f.authRequests, observed)
		if gate := f.authReplyGate; gate != nil {
			f.mu.Unlock()
			gate(r)
			f.mu.Lock()
		}
		if r.Context().Err() != nil {
			return
		}
		if f.authReplyCode != "" {
			switch f.authReplyCode {
			case "p2p.rate_limited":
				w.WriteHeader(http.StatusTooManyRequests)
			case "p2p.user_unauthorized":
				w.WriteHeader(http.StatusUnauthorized)
			default:
				f.t.Error("unsupported explicit auth reply refusal")
				w.WriteHeader(http.StatusInternalServerError)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"code": f.authReplyCode})
			return
		}
	}
	switch r.URL.Path {
	case "/v1/login":
		if f.loginSession == nil {
			f.t.Error("login fixture requires an explicit real test session")
			f.refuse(w, "p2p.user_unauthorized")
			return
		}
		_ = json.NewEncoder(w).Encode(*f.loginSession)
	case "/v1/identity":
		f.serviceQueries++
		if f.serviceEntered != nil {
			release := f.serviceRelease
			select {
			case f.serviceEntered <- struct{}{}:
			default:
			}
			f.mu.Unlock()
			select {
			case <-r.Context().Done():
			case <-release:
			}
			f.mu.Lock()
			return
		}
		if f.serviceCode != "" {
			f.refuse(w, f.serviceCode)
			return
		}
		var request struct {
			Nonce string `json:"nonce"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || !protocol.ValidNonce(request.Nonce) {
			f.t.Error("invalid identity challenge")
			return
		}
		identity := f.account.identity
		identity.Nonce = request.Nonce
		body, _ := json.Marshal([]any{"dshker.service.v1", identity.Version, identity.ServiceID, identity.PublicKey, identity.Certificate, identity.Nonce, identity.HTTPSOrigin, identity.WSSURL, identity.STUNAddress})
		identity.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.caKey, body))
		_ = json.NewEncoder(w).Encode(identity)
	case "/v1/logout":
		if f.loginSession != nil {
			if r.Header.Get("Authorization") != "Bearer "+f.loginSession.Token {
				f.refuse(w, "p2p.user_unauthorized")
				return
			}
			f.logoutRevoked = true
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"loggedOut": true})
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
		if r.Header.Get("Authorization") != "Bearer "+f.grantSessionToken {
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
		if f.scopedIdentities != nil {
			pairs := make([]controlplane.Pair, 0, len(f.scopedIdentities))
			for _, identity := range f.scopedIdentities {
				pairs = append(pairs, identity.Pair)
			}
			_ = json.NewEncoder(w).Encode(pairs)
			return
		}
		if f.scopedIdentity != nil {
			_ = json.NewEncoder(w).Encode([]controlplane.Pair{f.scopedIdentity.Pair})
			return
		}
		_ = json.NewEncoder(w).Encode([]controlplane.Pair{})
	case "/v1/user":
		if f.loginSession != nil && (f.logoutRevoked || r.Header.Get("Authorization") != "Bearer "+f.loginSession.Token) {
			f.refuse(w, "p2p.user_unauthorized")
			return
		}
		_ = json.NewEncoder(w).Encode(controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"})
	case "/v1/networks":
		if f.networks != nil {
			_ = json.NewEncoder(w).Encode(f.networks)
			return
		}
		_ = json.NewEncoder(w).Encode([]controlplane.Network{{NetworkID: f.networkID, UserID: f.selectedUserID, Name: "selected network", MaxDevices: 10}})
	case "/v2/links/state":
		// Successful bootstrap wakes the real engine. This isolated composition's
		// pinned remote is explicitly offline; it cannot establish a candidate.
		var request protocol.LinkStateRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil || !request.Registration.Valid() {
			f.t.Error("bootstrap wake changed the selected link scope")
			f.refuse(w, "p2p.invalid_request")
			return
		}
		if request.UserID != f.selectedUserID {
			f.refuse(w, "p2p.user_unauthorized")
			return
		}
		if !f.hasScopedPair(request.NetworkID, request.PairID, false) {
			f.refuse(w, "p2p.pair_revoked")
			return
		}
		f.refuse(w, "p2p.peer_offline")
	case "/v2/pairs/identity":
		var request protocol.PairIdentityRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.UserID != f.selectedUserID || !request.Registration.Valid() || !f.hasScopedPair(request.NetworkID, request.PairID, true) {
			f.t.Error("scoped identity request changed explicit account/network/SQL pair scope")
			f.refuse(w, "p2p.invalid_request")
			return
		}
		f.identityRequests = append(f.identityRequests, request)
		if f.identityEntered != nil {
			release := f.identityRelease
			select {
			case f.identityEntered <- struct{}{}:
			default:
			}
			f.mu.Unlock()
			select {
			case <-release:
			case <-r.Context().Done():
			}
			f.mu.Lock()
			if r.Context().Err() != nil {
				return
			}
		}
		if f.identityCode != "" {
			f.refuse(w, f.identityCode)
			return
		}
		identity := f.scopedIdentity
		for index := range f.scopedIdentities {
			if f.scopedIdentities[index].Pair.PairID == request.PairID && f.scopedIdentities[index].Pair.NetworkID == request.NetworkID {
				identity = &f.scopedIdentities[index]
				break
			}
		}
		_ = json.NewEncoder(w).Encode(identity)
	default:
		if strings.HasPrefix(r.URL.Path, "/v1/networks/") && strings.HasSuffix(r.URL.Path, "/devices") {
			_ = json.NewEncoder(w).Encode(f.networkDevices)
			return
		}
		if r.URL.Path == "/v1/devices" {
			_ = json.NewEncoder(w).Encode([]controlplane.DeviceEntry{})
			return
		}
		f.t.Errorf("unexpected certificate workflow request %s", r.URL.Path)
		f.refuse(w, "p2p.invalid_request")
	}
}

func (f *certificateFixture) hasScopedPair(networkID, pairID string, rowID bool) bool {
	identities := f.scopedIdentities
	if identities == nil && f.scopedIdentity != nil {
		identities = []controlplane.PairIdentity{*f.scopedIdentity}
	}
	for _, identity := range identities {
		if identity.Pair.NetworkID == networkID && ((rowID && identity.Pair.PairID == pairID) || (!rowID && (identity.Target.DeviceID == pairID || identity.Initiator.DeviceID == pairID))) {
			return true
		}
	}
	return false
}

func (f *certificateFixture) refuse(w http.ResponseWriter, code string) {
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
}

func (f *certificateFixture) signals(w http.ResponseWriter, r *http.Request) {
	if f.signalClosed != nil {
		defer close(f.signalClosed)
	}
	f.mu.Lock()
	f.signalAttempts = append(f.signalAttempts, time.Now())
	reject := len(f.signalAttempts) == f.rejectSignalAttempt
	f.mu.Unlock()
	if reject {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "p2p.server_unavailable"})
		return
	}
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.ControlSubprotocol}})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	f.mu.Lock()
	f.subscriptions++
	f.mu.Unlock()
	_, data, err := connection.Read(r.Context())
	var hello protocol.ControlHello
	if err != nil || protocol.DecodeControl(data, &hello) != nil || hello.Version != protocol.ControlVersion || hello.Type != "hello" {
		f.t.Error("invalid control-v2 registration")
		return
	}
	f.mu.Lock()
	f.hellos = append(f.hellos, hello)
	f.mu.Unlock()
	if f.signalReadyGate != nil {
		f.signalReadyGate()
	}
	data, _ = json.Marshal(protocol.ControlReady{Version: protocol.ControlVersion, Type: "ready", DeviceID: f.original.DeviceID, UserID: hello.UserID, Registration: protocol.RegistrationFence{ServerEpoch: protocol.NewNonce(), SubscriptionID: protocol.NewNonce(), CoreInstanceID: hello.CoreInstanceID}, Capabilities: []string{protocol.CapabilityCandidate}})
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
