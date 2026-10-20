package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func newRecoveryScopeFixture(t *testing.T) *accountTransportTLS {
	t.Helper()
	f := newAccountTransportTLS(t, false)
	if err := f.account.host.SaveCredential(f.account.identity.ServiceID, f.device, f.credentials.private); err != nil {
		t.Fatal(err)
	}
	return f
}

func callRecoveryScope(ctx context.Context, f *accountTransportTLS, serviceID, deviceID, token string) (any, error) {
	payload, _ := json.Marshal(scopedRequest{ServiceID: serviceID, Data: json.RawMessage(`{"deviceId":"` + deviceID + `","token":"` + token + `"}`)})
	return f.account.host.Handle(ctx, "device.certificate_recovery_scope", payload)
}

func TestCertificateRecoveryScopeRealTLSPublicOwnerKeepsSelectedBAndOriginalA(t *testing.T) {
	f := newRecoveryScopeFixture(t)
	f.account.device.Certificate = f.credentials.sign(time.Now().Add(-time.Hour))
	f.reply = func(r *http.Request) (any, bool) {
		if strings.HasSuffix(r.URL.Path, "/devices") {
			return []controlplane.DeviceEntry{{DeviceID: f.device.DeviceID, UserID: f.device.UserID, Name: f.device.Name, Presence: "offline"}}, true
		}
		return nil, false
	}
	before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
	value, err := callRecoveryScope(context.Background(), f, f.account.identity.ServiceID, f.device.DeviceID, f.token)
	if err != nil {
		t.Fatal("named recovery owner could not read fresh scope while ordinary device snapshot is expired", err)
	}
	encoded, _ := json.Marshal(value)
	var result struct {
		User     controlplane.User  `json:"user"`
		Networks []DirectoryNetwork `json:"networks"`
	}
	if protocol.DecodeExact(encoded, &result) != nil || result.User != f.user || len(result.Networks) != 1 || result.Networks[0].NetworkID != f.network.NetworkID || result.Networks[0].UserID != f.user.UserID || len(result.Networks[0].Devices) != 1 || result.Networks[0].Devices[0].DeviceID != f.device.DeviceID || result.Networks[0].Devices[0].UserID != f.device.UserID {
		t.Fatal("fresh projection lost selected B or the original device membership")
	}
	if bytes.Contains(encoded, []byte(f.token)) || bytes.Contains(encoded, []byte(`"privateKey"`)) || bytes.Contains(encoded, []byte(`"publicKey"`)) || bytes.Contains(encoded, []byte(`"revision"`)) || bytes.Contains(encoded, []byte(`"fetchedAt"`)) {
		t.Fatal("recovery projection exposed a secret or forged ordinary directory metadata")
	}
	if after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID)); !bytes.Equal(before, after) {
		t.Fatal("read-only recovery scope published an ordinary directory cache")
	}
	requests := f.snapshot()
	if len(requests) != 3 || requests[0].path != "/v1/user" || requests[1].path != "/v1/networks" || requests[2].path != "/v1/networks/"+f.network.NetworkID+"/devices" {
		t.Fatal("recovery owner did not perform each fresh authorization read", requests)
	}
	for _, request := range requests {
		if request.verified || request.deviceID != "" || !request.bearer {
			t.Fatal("named public recovery read did not use only the real selected Bearer", request)
		}
	}
	data, _ := json.Marshal(map[string]string{"token": f.token})
	_, err = f.account.management(context.Background(), "devices.list", data)
	certificateError(t, err, "p2p.certificate_recovery_required")
	_, err = f.account.readDirectory(context.Background())
	certificateError(t, err, "p2p.certificate_recovery_required")
	if len(f.snapshot()) != 3 || f.account.device.UserID != f.device.UserID || f.account.client.Account() != f.user.UserID || f.device.UserID == f.user.UserID {
		t.Fatal("scope read changed owner A/selected B or retried an ordinary request publicly")
	}
}

func TestCertificateRecoveryScopeRejectsAuthorityChangesAfterEveryHTTPRead(t *testing.T) {
	for _, stage := range []string{"user", "networks", "devices"} {
		for _, change := range []string{"token", "sessionExpiry", "credential", "credentialRemoved", "serviceRemoved", "accountLifetime", "cancelled"} {
			t.Run(stage+"/"+change, func(t *testing.T) {
				f := newRecoveryScopeFixture(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				lifetime, endAccount := context.WithCancel(context.Background())
				defer endAccount()
				f.account.lifetime = lifetime
				paths := map[string]string{"user": "/v1/user", "networks": "/v1/networks", "devices": "/v1/networks/" + f.network.NetworkID + "/devices"}
				want := map[string]string{"token": "p2p.user_scope_mismatch", "sessionExpiry": "p2p.user_scope_mismatch", "credential": "p2p.identity_mismatch", "credentialRemoved": "p2p.invalid_device_state", "serviceRemoved": "p2p.service_unconfigured", "accountLifetime": "p2p.request_cancelled", "cancelled": "p2p.request_cancelled"}[change]
				f.beforeReply = func(request accountTransportRequest) {
					if request.path != paths[stage] {
						return
					}
					host, serviceID := f.account.host, f.account.identity.ServiceID
					switch change {
					case "token", "sessionExpiry":
						session, exists, err := host.readAccountSession(serviceID)
						if err != nil || !exists {
							t.Error("test session disappeared", err)
							return
						}
						if change == "token" {
							session.Token = strings.Repeat("e", 64)
						} else {
							session.ExpiresAt++
						}
						if err := host.saveAccountSession(serviceID, session); err != nil {
							t.Error(err)
						}
					case "credential":
						device := f.device
						device.Name = "concurrent original record update"
						if err := host.SaveCredential(serviceID, device, f.credentials.private); err != nil {
							t.Error(err)
						}
					case "credentialRemoved":
						if err := host.DeleteCredential(serviceID); err != nil {
							t.Error(err)
						}
					case "serviceRemoved":
						// Removal publishes its tombstone before waiting for account.mu.
						// Model that published fence without running close on this reader.
						host.mu.Lock()
						host.removalRevision++
						if host.removedAt == nil {
							host.removedAt = map[string]uint64{}
						}
						host.removedAt[serviceID] = host.removalRevision
						host.mu.Unlock()
					case "accountLifetime":
						endAccount()
					case "cancelled":
						cancel()
					}
				}
				before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
				value, err := callRecoveryScope(ctx, f, f.account.identity.ServiceID, f.device.DeviceID, f.token)
				certificateError(t, err, want)
				if value != nil || len(f.snapshot()) != map[string]int{"user": 1, "networks": 2, "devices": 3}[stage] {
					t.Fatal("stale operation continued reading or returned a late scope")
				}
				after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
				if !bytes.Equal(before, after) {
					t.Fatal("rejected scope changed directory cache bytes")
				}
			})
		}
	}
}

func TestCertificateRecoveryScopeRejectsMalformedOrDuplicateFreshProjection(t *testing.T) {
	for _, name := range []string{"badUser", "nullNetworks", "missingNetworkField", "duplicateNetwork", "foreignNetwork", "invalidNetwork", "nullDevices", "missingDeviceField", "duplicateDevice", "invalidDevice", "invalidPresence", "refused"} {
		t.Run(name, func(t *testing.T) {
			f := newRecoveryScopeFixture(t)
			f.reply = func(r *http.Request) (any, bool) {
				switch {
				case name == "badUser" && r.URL.Path == "/v1/user":
					return controlplane.User{}, true
				case r.URL.Path == "/v1/networks":
					network := f.network
					switch name {
					case "nullNetworks":
						return json.RawMessage(`null`), true
					case "missingNetworkField":
						return json.RawMessage(`[{"networkId":"` + network.NetworkID + `"}]`), true
					case "duplicateNetwork":
						return []controlplane.Network{network, network}, true
					case "foreignNetwork":
						network.UserID = f.device.UserID
						return []controlplane.Network{network}, true
					case "invalidNetwork":
						network.MaxDevices = 0
						return []controlplane.Network{network}, true
					}
				case strings.HasSuffix(r.URL.Path, "/devices"):
					device := controlplane.DeviceEntry{DeviceID: f.device.DeviceID, UserID: f.device.UserID, Name: f.device.Name, Presence: "offline"}
					switch name {
					case "nullDevices":
						return json.RawMessage(`null`), true
					case "missingDeviceField":
						return json.RawMessage(`[{"deviceId":"` + device.DeviceID + `"}]`), true
					case "duplicateDevice":
						return []controlplane.DeviceEntry{device, device}, true
					case "invalidDevice":
						device.UserID = ""
						return []controlplane.DeviceEntry{device}, true
					case "invalidPresence":
						device.Presence = "unknown"
						return []controlplane.DeviceEntry{device}, true
					}
				}
				return nil, false
			}
			if name == "refused" {
				f.code = "p2p.user_unauthorized"
			}
			before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
			value, err := callRecoveryScope(context.Background(), f, f.account.identity.ServiceID, f.device.DeviceID, f.token)
			if err == nil || value != nil {
				t.Fatal("malformed/denied authorization became an empty success")
			}
			if name == "refused" {
				certificateError(t, err, "p2p.user_unauthorized")
			}
			after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
			if !bytes.Equal(before, after) {
				t.Fatal("invalid projection changed directory cache bytes")
			}
		})
	}
}

func TestCertificateRecoveryScopeExactRequestAndTrueEmptyProjection(t *testing.T) {
	f := newRecoveryScopeFixture(t)
	for _, data := range []string{`{}`, `null`, `{"deviceId":"` + f.device.DeviceID + `","token":"` + f.token + `","networkId":"` + f.network.NetworkID + `"}`, `{"deviceId":"` + f.device.DeviceID + `","token":"` + f.token + `","token":"` + f.token + `"}`} {
		payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: json.RawMessage(data)})
		value, err := f.account.host.Handle(context.Background(), "device.certificate_recovery_scope", payload)
		certificateError(t, err, "p2p.invalid_request")
		if value != nil || len(f.snapshot()) != 0 {
			t.Fatal("non-exact request reached public authorization")
		}
	}
	f.reply = func(r *http.Request) (any, bool) { return []controlplane.Network{}, r.URL.Path == "/v1/networks" }
	value, err := callRecoveryScope(context.Background(), f, f.account.identity.ServiceID, f.device.DeviceID, f.token)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(certificateRecoveryScope)
	if result.User != f.user || result.Networks == nil || len(result.Networks) != 0 || len(f.snapshot()) != 2 {
		t.Fatal("server's true empty owned-network set was inferred or fabricated", result)
	}
}

func TestCertificateRecoveryScopeRejectsMissingOrWrongLocalAuthorityBeforeHTTP(t *testing.T) {
	for _, name := range []string{"wrongDevice", "wrongService", "aliasedService", "invalidService", "missingRecord", "wrongServiceKey", "wrongEndpoints", "wrongBoundKey", "missingSession", "wrongToken", "expiredSession", "unknownPhase", "closed", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			f := newRecoveryScopeFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			serviceID, deviceID, token, want := f.account.identity.ServiceID, f.device.DeviceID, f.token, "p2p.identity_mismatch"
			switch name {
			case "wrongDevice":
				deviceID = protocol.NewID()
			case "wrongService":
				serviceID, want = protocol.NewID(), "p2p.service_unconfigured"
			case "aliasedService":
				serviceID = protocol.NewID()
				f.account.host.accounts[serviceID] = f.account
			case "invalidService":
				serviceID, want = "foreign-service", "p2p.invalid_request"
			case "missingRecord":
				if err := f.account.host.DeleteCredential(serviceID); err != nil {
					t.Fatal(err)
				}
				want = "p2p.invalid_device_state"
			case "wrongServiceKey":
				f.account.identity.PublicKey = bytes.Repeat([]byte{1}, 32)
			case "wrongEndpoints":
				f.account.endpoints.STUNAddress = "127.0.0.1:3479"
			case "wrongBoundKey":
				f.account.device.PublicKey = bytes.Repeat([]byte{1}, 32)
			case "missingSession":
				if err := f.account.host.deleteAccountSession(serviceID); err != nil {
					t.Fatal(err)
				}
				want = "p2p.user_login_required"
			case "wrongToken":
				token, want = strings.Repeat("e", 64), "p2p.user_scope_mismatch"
			case "expiredSession":
				if err := f.account.host.saveAccountSession(serviceID, persistedAccountSession{Token: token, ExpiresAt: time.Now().Add(-time.Minute).Unix()}); err != nil {
					t.Fatal(err)
				}
				want = "p2p.user_session_expired"
			case "unknownPhase":
				f.account.httpPhase, want = accountHTTPUnknown, "p2p.invalid_device_state"
			case "closed":
				f.account.closed, want = true, "p2p.service_unconfigured"
			case "cancelled":
				cancel()
				want = "p2p.request_cancelled"
			}
			value, err := callRecoveryScope(ctx, f, serviceID, deviceID, token)
			certificateError(t, err, want)
			if value != nil || len(f.snapshot()) != 0 {
				t.Fatal("rejected local authority reached HTTP or fabricated a scope")
			}
		})
	}
}
