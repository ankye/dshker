package helper

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

// These are production auth owners, not a quota simulator. Every assertion
// observes the completed real TLS request and its exact Bearer/device identity.
func callTransportAuth(f *accountTransportTLS, operation string) error {
	switch operation {
	case "selectedAccount":
		_, err := f.account.selectedAccount(context.Background())
		return err
	case "confirmLogin":
		return f.account.confirmLogin(context.Background(), controlplane.UserSession{User: f.user, Token: f.token, ExpiresAt: time.Now().Add(time.Hour).Unix()})
	default:
		data, _ := json.Marshal(map[string]string{"token": f.token})
		_, err := f.account.management(context.Background(), operation, data)
		return err
	}
}

func TestAccountAuthTransportRealTLSValidDeviceUsesOneFreshRequest(t *testing.T) {
	for _, operation := range []string{"user.current", "user.logout", "selectedAccount", "confirmLogin"} {
		t.Run(operation, func(t *testing.T) {
			f := newAccountTransportTLS(t, false)
			if err := callTransportAuth(f, operation); err != nil {
				t.Fatal("valid original identity blocked real selected-B authentication", err)
			}
			requests := f.snapshot()
			path, method := "/v1/user", "GET"
			if operation == "user.logout" {
				path, method = "/v1/logout", "POST"
			}
			if len(requests) != 1 {
				t.Fatal("fresh auth read was cached, omitted or replayed", len(requests))
			}
			request := requests[0]
			if request.path != path || request.method != method || !request.verified || request.deviceID != f.device.DeviceID || !request.bearer {
				t.Fatalf("auth resource identity is not the original verified device with selected-B Bearer: method=%s path=%s verified=%t device=%s bearer=%t", request.method, request.path, request.verified, request.deviceID, request.bearer)
			}
			if f.account.client.Account() != f.user.UserID || f.account.device.UserID != f.device.UserID || f.user.UserID == f.device.UserID {
				t.Fatal("auth transport substituted enrollment owner A for selected B")
			}
		})
	}
}

func TestAccountAuthTransportRealTLSFailureIsNeverPublicReplay(t *testing.T) {
	for _, operation := range []string{"user.current", "user.logout", "selectedAccount", "confirmLogin"} {
		for _, code := range []string{"tls", "p2p.user_unauthorized", "p2p.rate_limited"} {
			t.Run(operation+"/"+code, func(t *testing.T) {
				f := newAccountTransportTLS(t, code == "tls")
				want, count := code, 1
				if code == "tls" {
					want, count = "p2p.server_unavailable", 0
				} else {
					f.code = code
				}
				err := callTransportAuth(f, operation)
				requests := f.snapshot()
				if err == nil || err.Error() != want || len(requests) != count {
					t.Fatal("auth failure changed its refusal or replayed a request", err, len(requests))
				}
				for _, request := range requests {
					if !request.verified || request.deviceID != f.device.DeviceID || !request.bearer {
						t.Fatal("failed auth request borrowed anonymous/enrollment authority")
					}
				}
				if f.account.activationPending != nil || f.account.httpPhase != accountHTTPDevice || f.account.client.Account() != f.user.UserID {
					t.Fatal("valid-device auth failure invented recovery state or changed selected B")
				}
			})
		}
	}
}

func TestAccountAuthTransportMissingIdentityNeverUsesPublicOwner(t *testing.T) {
	for _, operation := range []string{"user.current", "user.logout", "selectedAccount", "confirmLogin"} {
		for _, change := range []string{"unknown", "missing-client", "base-as-device", "missing-record", "wrong-key", "closed", "cancelled"} {
			t.Run(operation+"/"+change, func(t *testing.T) {
				f := newAccountTransportTLS(t, false)
				originalClient := f.account.client
				t.Cleanup(originalClient.Close)
				want := "p2p.invalid_device_state"
				switch change {
				case "unknown":
					f.account.httpPhase = accountHTTPUnknown
				case "missing-client":
					f.account.client = nil
				case "base-as-device":
					f.account.client = f.account.base
				case "missing-record":
					if err := f.account.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
						t.Fatal(err)
					}
				case "wrong-key":
					f.account.device.PublicKey = make([]byte, 32)
					want = "p2p.identity_mismatch"
				case "closed":
					f.account.httpPhase = accountHTTPClosed
					want = "p2p.service_unconfigured"
				case "cancelled":
					f.account.host.cancel()
					want = "p2p.request_cancelled"
				}
				err := callTransportAuth(f, operation)
				if err == nil || err.Error() != want || len(f.snapshot()) != 0 {
					t.Fatal("missing/corrupt original authority gained a public auth request", err, len(f.snapshot()))
				}
			})
		}
	}
}

func TestAccountAuthTransportRepeatedSelectionDoesNotCacheFreshAuthorization(t *testing.T) {
	f := newAccountTransportTLS(t, false)
	if selected, err := f.account.selectedAccount(context.Background()); err != nil || selected != f.user.UserID {
		t.Fatal("first exact selected-user read failed", err)
	}
	f.code = "p2p.user_unauthorized"
	selected, err := f.account.selectedAccount(context.Background())
	requests := f.snapshot()
	if selected != "" || err == nil || err.Error() != "p2p.user_unauthorized" || len(requests) != 2 {
		t.Fatal("fresh selected-user revocation was hidden by a completed-read cache", selected, err, len(requests))
	}
	for _, request := range requests {
		if request.path != "/v1/user" || !request.verified || request.deviceID != f.device.DeviceID || !request.bearer {
			t.Fatal("fresh auth read lost its exact transport/session identity")
		}
	}
}

func TestAccountAuthTransportSelectedTLSExpiryRaceNeverReselectsBase(t *testing.T) {
	f, session := authDeviceFixture(t, 2*time.Second)
	client, err := f.account.authenticationClientLocked(context.Background())
	if err != nil || client != f.account.client {
		t.Fatal("valid original identity was not selected before expiry", err)
	}
	leaf, err := f.account.base.ValidateDevice(f.original, f.private, f.account.identity, false)
	if err != nil {
		t.Fatal(err)
	}
	// Close only idle HTTP connections; this does not stop the existing WSS.
	client.Close()
	timer := time.NewTimer(time.Until(leaf.NotAfter) + 25*time.Millisecond)
	defer timer.Stop()
	<-timer.C
	_, err = client.CurrentUser(context.Background(), session.Token)
	if err == nil || err.Error() != "p2p.server_unavailable" {
		t.Fatal("selected request did not preserve its actual TLS expiry refusal", err)
	}
	f.mu.Lock()
	requests := len(f.authRequests)
	f.mu.Unlock()
	if requests != 0 || f.account.activationPending != nil {
		t.Fatal("expiry after selection replayed through public auth or established pending", requests)
	}
}
