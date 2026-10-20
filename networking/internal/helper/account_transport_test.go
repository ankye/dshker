package helper

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type accountTransportRequest struct {
	method, path, deviceID string
	verified, bearer       bool
}

// A test-only wire observer with real TLS client-certificate verification and
// production Client/Helper calls. Its DTO replies do not prove Gin/SQLite E2E.
type accountTransportTLS struct {
	mu          sync.Mutex
	requests    []accountTransportRequest
	account     *account
	device      controlplane.Device
	user        controlplane.User
	token       string
	network     controlplane.Network
	code        string
	credentials *certificateFixture
	beforeReply func(accountTransportRequest)
	reply       func(*http.Request) (any, bool)
}

func newAccountTransportTLS(t *testing.T, rejectDeviceTLS bool) *accountTransportTLS {
	t.Helper()
	certificate := newCertificateFixture(t, 30*24*time.Hour)
	user := controlplane.User{UserID: protocol.NewID(), Username: "selected-transport@example.test"}
	for user.UserID == certificate.original.UserID {
		user.UserID = protocol.NewID()
	}
	f := &accountTransportTLS{device: certificate.original, user: user, token: strings.Repeat("d", 64), credentials: certificate}
	f.network = controlplane.Network{NetworkID: protocol.NewID(), UserID: user.UserID, Name: "selected transport network", MaxDevices: 10}
	server := httptest.NewUnstartedServer(http.HandlerFunc(f.serve))
	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(certificate.ca)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: clientCAs}
	if rejectDeviceTLS {
		server.TLS.VerifyConnection = func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 0 {
				return errors.New("test.device_tls_rejected")
			}
			return nil
		}
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	endpoints := controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals", STUNAddress: "127.0.0.1:3478"}
	base, err := controlplane.New(endpoints, roots)
	if err != nil {
		t.Fatal(err)
	}
	identity := certificate.account.identity
	identity.HTTPSOrigin, identity.WSSURL, identity.STUNAddress = endpoints.HTTPSOrigin, endpoints.WSSURL, endpoints.STUNAddress
	client, err := base.WithDevice(f.device, certificate.private, identity)
	if err != nil {
		t.Fatal(err)
	}
	client.SetAccount(user.UserID)
	host := New(context.Background())
	host.SetDeviceKeys(newMemoryStore())
	f.account = &account{host: host, base: base, client: client, httpPhase: accountHTTPDevice, identity: identity, endpoints: endpoints, device: f.device}
	host.accounts[identity.ServiceID] = f.account
	t.Cleanup(host.Close)
	if err := host.SaveCredential(identity.ServiceID, f.device, certificate.private); err != nil {
		t.Fatal(err)
	}
	if err := host.saveAccountSession(identity.ServiceID, persistedAccountSession{Token: f.token, ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	f.account.rememberToken(f.token)
	return f
}

func (f *accountTransportTLS) serve(w http.ResponseWriter, r *http.Request) {
	request := accountTransportRequest{method: r.Method, path: r.URL.Path, bearer: r.Header.Get("Authorization") == "Bearer "+f.token}
	if r.TLS != nil && len(r.TLS.PeerCertificates) != 0 {
		request.deviceID = r.TLS.PeerCertificates[0].Subject.CommonName
		request.verified = len(r.TLS.VerifiedChains) != 0
	}
	f.mu.Lock()
	f.requests = append(f.requests, request)
	code := f.code
	beforeReply, reply := f.beforeReply, f.reply
	f.mu.Unlock()
	if beforeReply != nil {
		beforeReply(request)
	}
	w.Header().Set("Content-Type", "application/json")
	if code != "" || !request.bearer {
		if !request.bearer {
			code = "p2p.user_unauthorized"
		}
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
		return
	}
	if reply != nil {
		if value, handled := reply(r); handled {
			_ = json.NewEncoder(w).Encode(value)
			return
		}
	}
	switch {
	case r.URL.Path == "/v1/user":
		_ = json.NewEncoder(w).Encode(f.user)
	case r.URL.Path == "/v1/logout":
		_ = json.NewEncoder(w).Encode(map[string]bool{"loggedOut": true})
	case r.URL.Path == "/v1/networks" && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode([]controlplane.Network{f.network})
	case r.URL.Path == "/v1/networks" || r.Method == http.MethodPatch:
		_ = json.NewEncoder(w).Encode(f.network)
	case strings.HasSuffix(r.URL.Path, "/enrollment-tokens"):
		_ = json.NewEncoder(w).Encode(controlplane.EnrollmentGrant{Token: strings.Repeat("g", 64), NetworkID: f.network.NetworkID, ExpiresAt: time.Now().Add(time.Minute).Unix()})
	case r.Method == http.MethodDelete:
		key := "unbound"
		if r.URL.Path == "/v1/networks/"+f.network.NetworkID || strings.Contains(r.URL.Path, "/pairs/") {
			key = "deleted"
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{key: true})
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/devices"):
		_ = json.NewEncoder(w).Encode(map[string]bool{"bound": true})
	case strings.HasSuffix(r.URL.Path, "/pairs"):
		_ = json.NewEncoder(w).Encode([]controlplane.Pair{})
	default:
		_ = json.NewEncoder(w).Encode([]controlplane.DeviceEntry{{DeviceID: f.device.DeviceID, UserID: f.user.UserID, Name: f.device.Name, Presence: "online"}})
	}
}

func (f *accountTransportTLS) snapshot() []accountTransportRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]accountTransportRequest{}, f.requests...)
}

func TestAccountTransportRealTLSDeviceBearerReadsKeepSelectedAccount(t *testing.T) {
	f := newAccountTransportTLS(t, false)
	data, _ := json.Marshal(map[string]string{"token": f.token})
	value, err := f.account.management(context.Background(), "user.current", data)
	if err != nil || value.(controlplane.User) != f.user {
		t.Fatal("current user did not preserve the explicit selected account B", err)
	}
	if _, err := f.account.readDirectory(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.account.selectedNetworkNames(context.Background(), f.user.UserID); err != nil {
		t.Fatal(err)
	}
	requests := f.snapshot()
	if len(requests) != 6 {
		t.Fatal("ordinary current/directory/fresh-network reads changed their required calls", len(requests))
	}
	for _, request := range requests {
		if !request.verified || request.deviceID != f.device.DeviceID || !request.bearer {
			t.Fatalf("bound ordinary Bearer request did not carry verified original device A and selected B session: method=%s path=%s verified=%t device=%s bearer=%t", request.method, request.path, request.verified, request.deviceID, request.bearer)
		}
	}
	if f.account.device.UserID != f.device.UserID || f.account.client.Account() != f.user.UserID || f.device.UserID == f.user.UserID {
		t.Fatal("device enrollment owner A replaced selected user B")
	}
}

func TestAccountTransportRealTLSOrdinaryBearerManagementUsesDevice(t *testing.T) {
	for _, method := range []string{"devices.list", "networks.rename", "networks.limit", "networks.delete", "networks.devices", "networks.pairs", "network.leave", "devices.bind", "devices.unbind", "networks.deletePair", "networks.list", "networks.create", "device.enrollmentToken"} {
		t.Run(method, func(t *testing.T) {
			f := newAccountTransportTLS(t, false)
			request := map[string]any{"token": f.token}
			switch method {
			case "networks.rename":
				request["networkId"], request["name"] = f.network.NetworkID, "renamed network"
			case "networks.limit":
				request["networkId"], request["maxDevices"] = f.network.NetworkID, 10
			case "networks.delete", "networks.devices", "networks.pairs", "device.enrollmentToken":
				request["networkId"] = f.network.NetworkID
			case "network.leave", "devices.bind", "devices.unbind":
				request["networkId"], request["deviceId"] = f.network.NetworkID, f.device.DeviceID
			case "networks.deletePair":
				request["networkId"], request["pairId"] = f.network.NetworkID, protocol.NewID()
			case "networks.create":
				request["name"] = "created network"
			}
			data, _ := json.Marshal(request)
			f.account.mu.Lock()
			_, err := f.account.management(context.Background(), method, data)
			f.account.mu.Unlock()
			if err != nil {
				t.Fatal("ordinary management operation failed", err)
			}
			requests := f.snapshot()
			if len(requests) != 1 || !requests[0].verified || requests[0].deviceID != f.device.DeviceID || !requests[0].bearer {
				t.Fatal("ordinary management did not use exact device TLS plus selected Bearer", requests)
			}
		})
	}
}

func TestAccountTransportSetupRemainsExplicitlyPublic(t *testing.T) {
	f := newAccountTransportTLS(t, false)
	f.account.client.Close()
	f.account.client = nil
	f.account.httpPhase = accountHTTPSetup
	data, _ := json.Marshal(map[string]string{"token": f.token})
	value, err := f.account.management(context.Background(), "user.current", data)
	if err != nil || value.(controlplane.User) != f.user {
		t.Fatal("setup account could not authenticate its real Bearer", err)
	}
	requests := f.snapshot()
	if len(requests) != 1 || requests[0].verified || requests[0].deviceID != "" || !requests[0].bearer {
		t.Fatal("setup phase invented a device transport or changed selected session", requests)
	}
}

func TestAccountTransportBrokenDeviceAndClosedPhasesNeverUseBase(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		code   string
		change func(*accountTransportTLS)
	}{
		{"unknown", "p2p.invalid_device_state", func(f *accountTransportTLS) { f.account.httpPhase = accountHTTPUnknown }},
		{"missing-client", "p2p.invalid_device_state", func(f *accountTransportTLS) { f.account.client = nil }},
		{"setup-with-device", "p2p.invalid_device_state", func(f *accountTransportTLS) { f.account.httpPhase = accountHTTPSetup }},
		{"expired", "p2p.certificate_recovery_required", func(f *accountTransportTLS) {
			f.account.device.Certificate = f.credentials.sign(time.Now().Add(-time.Hour))
		}},
		{"invalid-certificate", "p2p.invalid_device_state", func(f *accountTransportTLS) { f.account.device.Certificate = []byte("invalid certificate") }},
		{"wrong-device", "p2p.invalid_device_state", func(f *accountTransportTLS) { f.account.device.DeviceID = protocol.NewID() }},
		{"closed", "p2p.service_unconfigured", func(f *accountTransportTLS) { f.account.httpPhase = accountHTTPClosed }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newAccountTransportTLS(t, false)
			t.Cleanup(f.account.client.Close)
			scenario.change(f)
			data, _ := json.Marshal(map[string]string{"token": f.token})
			_, err := f.account.management(context.Background(), "devices.list", data)
			if err == nil || err.Error() != scenario.code || len(f.snapshot()) != 0 {
				t.Fatal("invalid device phase sent a public request or changed its refusal", err, f.snapshot())
			}
		})
	}
}

func TestAccountTransportRealTLSFailureNeverRetriesWithPublicClient(t *testing.T) {
	f := newAccountTransportTLS(t, true)
	data, _ := json.Marshal(map[string]string{"token": f.token})
	_, err := f.account.management(context.Background(), "devices.list", data)
	if err == nil || err.Error() != "p2p.server_unavailable" || len(f.snapshot()) != 0 || f.account.httpPhase != accountHTTPDevice {
		t.Fatal("failed device TLS downgraded to public HTTP or changed phase", err, f.snapshot())
	}
}

func TestAccountTransportRealTLSAuthorizationFailureDoesNotRetryOrChangeDevice(t *testing.T) {
	for _, code := range []string{"p2p.user_unauthorized", "p2p.network_unauthorized", "p2p.rate_limited"} {
		t.Run(code, func(t *testing.T) {
			f := newAccountTransportTLS(t, false)
			f.code = code
			data, _ := json.Marshal(map[string]string{"token": f.token})
			_, err := f.account.management(context.Background(), "devices.list", data)
			requests := f.snapshot()
			if err == nil || err.Error() != code || len(requests) != 1 || !requests[0].verified || requests[0].deviceID != f.device.DeviceID || f.account.httpPhase != accountHTTPDevice || f.account.device.UserID != f.device.UserID || f.account.client.Account() != f.user.UserID {
				t.Fatal("authorization failure retried, changed device or borrowed enrollment owner", err, requests)
			}
		})
	}
}

func TestAccountTransportLogoutRetainsDeviceAndClosesOrdinaryAccess(t *testing.T) {
	f := newAccountTransportTLS(t, false)
	client := f.account.client
	data, _ := json.Marshal(map[string]string{"token": f.token})
	_, err := f.account.host.manage(context.Background(), f.account, "user.logout", data)
	if err != nil || f.account.client != client || f.account.httpPhase != accountHTTPDevice || f.account.device.UserID != f.device.UserID || client.Account() != "" {
		t.Fatal("logout destroyed or substituted the original device transport", err)
	}
	if _, exists, err := f.account.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
		t.Fatal("logout retained selected session authority", err)
	}
	requests := f.snapshot()
	if len(requests) != 1 || !requests[0].verified || requests[0].deviceID != f.device.DeviceID || !requests[0].bearer {
		t.Fatal("valid original device logout lost mTLS attribution or selected Bearer", requests)
	}
	f.account.close()
	_, err = f.account.management(context.Background(), "user.current", data)
	if err == nil || err.Error() != "p2p.service_unconfigured" || f.account.httpPhase != accountHTTPClosed || len(f.snapshot()) != 1 {
		t.Fatal("closed account started another ordinary HTTP operation", err)
	}
}
