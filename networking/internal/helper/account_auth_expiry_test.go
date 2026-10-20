package helper

import (
	"net/http"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

// A complete Host.Handle request starts with a valid real client certificate.
// The TLS server holds only the selected auth response until that exact signed
// NotAfter passes. No clock substitution, request retry or timeout change is used.
func authAcrossCertificateExpiry(t *testing.T, method, refusal string) (*certificateFixture, controlplane.UserSession, any, error) {
	t.Helper()
	f, session := authDeviceFixture(t, 3*time.Second)
	leaf, err := f.account.base.ValidateDevice(f.original, f.private, f.account.identity, false)
	if err != nil {
		t.Fatal(err)
	}
	if method != "user.login" {
		if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
			t.Fatal(err)
		}
	}
	path := "/v1/user"
	if method == "user.logout" {
		path = "/v1/logout"
	}
	f.mu.Lock()
	f.authReplyGate = func(r *http.Request) {
		if r.URL.Path != path {
			return
		}
		if !time.Now().Before(leaf.NotAfter) || len(r.TLS.PeerCertificates) != 1 || len(r.TLS.VerifiedChains) == 0 || r.TLS.PeerCertificates[0].Subject.CommonName != f.original.DeviceID || r.Header.Get("Authorization") != "Bearer "+session.Token {
			t.Error("auth response gate was not reached before the real original mTLS certificate expired")
			return
		}
		timer := time.NewTimer(time.Until(leaf.NotAfter) + 25*time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-r.Context().Done():
			t.Error("real auth request was cancelled before its certificate deadline")
		}
		// Public login itself succeeds; a refusal applies only to this selected
		// fresh user/revocation response, after the real expiry gate.
		if refusal != "" {
			f.mu.Lock()
			f.authReplyCode = refusal
			f.mu.Unlock()
		}
	}
	f.mu.Unlock()
	var value any
	if method == "user.login" {
		value, err = authHandle(f, method, map[string]string{"username": session.User.Username, "password": "test-only-password"})
	} else {
		value, err = authHandle(f, method, map[string]string{"token": session.Token})
	}
	if time.Now().Before(leaf.NotAfter) {
		t.Fatal("Host auth request did not actually cross the signed certificate deadline")
	}
	return f, session, value, err
}

func TestAccountAuthHostResponseCrossesRealCertificateExpiry(t *testing.T) {
	for _, method := range []string{"user.login", "user.current", "user.logout"} {
		t.Run(method, func(t *testing.T) {
			f, session, value, err := authAcrossCertificateExpiry(t, method, "")
			if err != nil {
				t.Fatal("successful real authentication crossed NotAfter but still attempted expired activation", err)
			}
			if method == "user.login" && value.(controlplane.UserSession) != session || method == "user.current" && value.(controlplane.User) != session.User {
				t.Fatal("completed authentication did not publish the exact real selected B result")
			}
			wantAccount := session.User.UserID
			if method == "user.logout" {
				wantAccount = ""
			}
			if f.account.client.Account() != wantAccount || f.account.device.UserID != f.original.UserID || f.account.manager.CandidatesActive() || len(f.account.authRecoveryJoins) != 0 {
				t.Fatal("cross-expiry auth lost selected scope/original A or returned without joining its local fence")
			}
			if method == "user.logout" {
				if f.account.activationPending != nil || f.account.activationSource != nil {
					t.Fatal("local logout cleanup invented recovery provenance")
				}
			} else {
				certificateError(t, f.account.activationPending, "p2p.certificate_recovery_required")
				if f.account.activationSource == nil {
					t.Fatal("cross-expiry pending has no fully validated original provenance")
				}
			}
			f.mu.Lock()
			requests := append([]accountTransportRequest{}, f.authRequests...)
			hellos, revoked := len(f.hellos), f.logoutRevoked
			f.authReplyGate = nil
			f.mu.Unlock()
			wantRequests := 1
			if method == "user.login" {
				wantRequests = 2
			}
			if len(requests) != wantRequests || hellos != 1 || f.runtimeCalls != 0 {
				t.Fatal("cross-expiry auth retried HTTP, dialed WSS or started a runtime", len(requests), hellos)
			}
			for _, request := range requests {
				if request.path == "/v1/login" {
					if request.verified || request.deviceID != "" {
						t.Fatal("public login contract was changed")
					}
				} else if !request.verified || request.deviceID != f.original.DeviceID || !request.bearer {
					t.Fatal("the selected real auth request was replayed anonymously")
				}
			}
			stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
			if err != nil || method == "user.logout" && (exists || !revoked) || method != "user.logout" && (!exists || stored.Token != session.Token || stored.ExpiresAt != session.ExpiresAt) {
				t.Fatal("cross-expiry auth lost the real durable result or fabricated revocation", err)
			}
			if method == "user.login" {
				current, err := authHandle(f, "user.current", map[string]string{"token": session.Token})
				if err != nil || current.(controlplane.User) != session.User {
					t.Fatal("cross-expiry login still cannot satisfy main's mandatory current confirmation", err)
				}
			}
		})
	}
}

func TestAccountAuthHostCrossExpiryKeepsRealAuthRefusal(t *testing.T) {
	for _, method := range []string{"user.login", "user.current", "user.logout"} {
		t.Run(method, func(t *testing.T) {
			f, _, _, err := authAcrossCertificateExpiry(t, method, "p2p.rate_limited")
			certificateError(t, err, "p2p.rate_limited")
			if method != "user.logout" && f.account.activationPending != nil {
				t.Fatal("failed real authentication was converted into pending success")
			}
			if method == "user.logout" {
				f.mu.Lock()
				revoked := f.logoutRevoked
				f.mu.Unlock()
				if revoked || f.account.client.Account() != "" || len(f.account.authRecoveryJoins) != 0 {
					t.Fatal("failed logout fabricated remote revocation or abandoned its local fence")
				}
			}
		})
	}
}
