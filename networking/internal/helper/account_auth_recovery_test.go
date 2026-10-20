package helper

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func authRecoveryFixture(t *testing.T) (*certificateFixture, controlplane.UserSession) {
	t.Helper()
	f, session := authDeviceFixture(t, 2*time.Second)
	leaf, err := f.account.base.ValidateDevice(f.original, f.private, f.account.identity, false)
	if err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(time.Until(leaf.NotAfter) + 25*time.Millisecond)
	defer timer.Stop()
	<-timer.C
	return f, session
}

func authDeviceFixture(t *testing.T, remaining time.Duration) (*certificateFixture, controlplane.UserSession) {
	t.Helper()
	f := newCertificateFixture(t, remaining)
	f.selectedUserID = f.original.UserID
	client, err := f.account.base.WithDevice(f.original, f.private, f.account.identity)
	if err != nil {
		t.Fatal(err)
	}
	client.SetAccount(f.original.UserID)
	manager, err := peersession.New(f.host.ctx, client, peersession.Config{Endpoints: f.account.endpoints, Authority: f.account.identity, Device: f.original, PrivateKey: f.private, CoreInstanceID: protocol.NewNonce()}, []controlplane.PairIdentity{}, func(context.Context, string) (runtimebridge.Binding, error) {
		return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_request")
	}, func(peersession.State) {})
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	f.account.client, f.account.manager, f.account.device, f.account.httpPhase = client, manager, f.original, accountHTTPDevice
	if err := f.host.SaveCredential(f.account.identity.ServiceID, f.original, f.private); err != nil {
		t.Fatal(err)
	}
	session := controlplane.UserSession{User: controlplane.User{UserID: protocol.NewID(), Username: "selected@example.test"}, Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	f.mu.Lock()
	f.loginSession, f.selectedUserID, f.grantSessionToken = &session, session.User.UserID, session.Token
	f.mu.Unlock()
	return f, session
}

func TestAccountAuthValidCertificateKeepsActualWSSFailure(t *testing.T) {
	f, session := authDeviceFixture(t, 30*24*time.Hour)
	f.mu.Lock()
	f.rejectSignalAttempt = 2
	f.mu.Unlock()
	value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
	certificateError(t, err, "p2p.server_unavailable")
	if value != nil || f.account.activationPending != nil || f.account.manager.CandidatesActive() {
		t.Fatal("valid-certificate WSS failure was disguised as pending auth success")
	}
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current.Token != session.Token || f.account.client.Account() != session.User.UserID {
		t.Fatal("valid-phase failure lost the real confirmed B session", err)
	}
}

func TestAccountAuthExpiredBranchRequiresFullOriginalBinding(t *testing.T) {
	for _, name := range []string{"missing-record", "wrong-key", "invalid-signature"} {
		t.Run(name, func(t *testing.T) {
			f, session := authRecoveryFixture(t)
			want := "p2p.identity_mismatch"
			switch name {
			case "missing-record":
				if err := f.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
				want = "p2p.invalid_device_state"
			case "wrong-key":
				f.account.device.PublicKey = make([]byte, 32)
			case "invalid-signature":
				f.account.device.Certificate = append([]byte(nil), f.original.Certificate...)
				f.account.device.Certificate[len(f.account.device.Certificate)-1] ^= 1
				want = "p2p.invalid_device_certificate"
			}
			value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
			certificateError(t, err, want)
			f.mu.Lock()
			calls := len(f.authRequests)
			f.mu.Unlock()
			if value != nil || calls != 0 || f.account.activationPending != nil || len(f.account.authRecoveryJoins) != 0 {
				t.Fatal("unverified expired state gained public auth/activation authority")
			}
		})
	}
}

func TestAccountAuthExpiredLogoutFailureDoesNotClaimRemoteRevocation(t *testing.T) {
	f, session := authRecoveryFixture(t)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	other := session
	other.Token = strings.Repeat("b", 64)
	f.loginSession = &other
	f.mu.Unlock()
	_, err := authHandle(f, "user.logout", map[string]string{"token": session.Token})
	certificateError(t, err, "p2p.user_unauthorized")
	f.mu.Lock()
	revoked := f.logoutRevoked
	f.mu.Unlock()
	if revoked || f.account.client.Account() != "" || f.account.manager.CandidatesActive() || len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("failed remote revocation was fabricated or local logout fencing was abandoned")
	}
}

func TestAccountAuthIssuedCertificateRequiresExistingExactPendingProvenance(t *testing.T) {
	for _, change := range []string{"missing-source", "wrong-source-client", "wrong-pending-code", "missing-record"} {
		t.Run(change, func(t *testing.T) {
			f, session := authRecoveryFixture(t)
			if _, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"}); err != nil {
				t.Fatal(err)
			}
			if _, err := f.call(f.original, f.networkID, session.Token); err != nil {
				t.Fatal(err)
			}
			want := "p2p.invalid_device_state"
			switch change {
			case "missing-source":
				f.account.activationSource = nil
			case "wrong-source-client":
				f.account.activationSource.client = f.account.base
				want = "p2p.identity_mismatch"
			case "wrong-pending-code":
				f.account.activationPending = errors.New("p2p.server_unavailable")
			case "missing-record":
				if err := f.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
			}
			f.mu.Lock()
			before := len(f.authRequests)
			f.mu.Unlock()
			value, err := authHandle(f, "user.current", map[string]string{"token": session.Token})
			certificateError(t, err, want)
			f.mu.Lock()
			after := len(f.authRequests)
			f.mu.Unlock()
			if value != nil || before != after || f.account.manager.CandidatesActive() {
				t.Fatal("valid certificate fabricated recovery provenance or activated corrupt authority")
			}
		})
	}
}

func authHandle(f *certificateFixture, method string, data any) (any, error) {
	encoded, _ := json.Marshal(data)
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: encoded})
	return f.host.Handle(context.Background(), method, payload)
}

func TestAccountAuthExpiredHostLoginThenCurrentPublishesRealSession(t *testing.T) {
	f, session := authRecoveryFixture(t)
	value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
	if err != nil || value.(controlplane.UserSession) != session {
		t.Fatal("Host.Handle login could not return the authenticated B session for main publication", err)
	}
	value, err = authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != session.User {
		t.Fatal("main's mandatory post-login current-user confirmation could not publish B", err)
	}
	assertAuthRecoveryPending(t, f, session)
}

func TestAccountAuthExpiredHostCurrentAdoptsPersistedRealSession(t *testing.T) {
	f, session := authRecoveryFixture(t)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		t.Fatal(err)
	}
	value, err := authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != session.User {
		t.Fatal("expired device blocked persisted-session adoption", err)
	}
	assertAuthRecoveryPending(t, f, session)
}

func TestAccountAuthExpiredHostLogoutRevokesRemoteToken(t *testing.T) {
	f, session := authRecoveryFixture(t)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		t.Fatal(err)
	}
	_, err := authHandle(f, "user.logout", map[string]string{"token": session.Token})
	if err != nil {
		t.Fatal("expired device prevented the actual public token revocation", err)
	}
	f.mu.Lock()
	revoked := f.logoutRevoked
	f.mu.Unlock()
	if !revoked || f.account.client.Account() != "" || f.account.manager.CandidatesActive() {
		t.Fatal("logout did not revoke remote/local selected authority")
	}
	if _, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
		t.Fatal("logout retained durable session", err)
	}
	_, err = f.account.base.CurrentUser(context.Background(), session.Token)
	certificateError(t, err, "p2p.user_unauthorized")
}

func assertAuthRecoveryPending(t *testing.T, f *certificateFixture, session controlplane.UserSession) {
	t.Helper()
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current.Token != session.Token || current.ExpiresAt != session.ExpiresAt || f.account.client.Account() != session.User.UserID || f.account.device.UserID != f.original.UserID || f.account.manager.CandidatesActive() {
		t.Fatal("auth failed to preserve real B/original A without candidate admission", err)
	}
	if _, err := f.account.manager.CurrentRegistration(session.User.UserID); err == nil {
		t.Fatal("auth falsely retained a usable expired registration")
	}
	certificateError(t, f.account.activationPending, "p2p.certificate_recovery_required")
	if len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("Host.Handle returned without owning and draining its recovery joins")
	}
	f.mu.Lock()
	requests := append([]accountTransportRequest{}, f.authRequests...)
	hellos := len(f.hellos)
	f.mu.Unlock()
	if hellos != 1 || f.runtimeCalls != 0 {
		t.Fatal("expired auth attempted new WSS registration or runtime work", hellos)
	}
	for _, request := range requests {
		if request.deviceID != "" || request.verified {
			t.Fatal("named public auth used expired device mTLS", request.path)
		}
	}
	_, err = authHandle(f, "directory.refresh", struct{}{})
	certificateError(t, err, "p2p.certificate_recovery_required")
}
