package helper

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/secret"
)

func TestPasswordResetClearsOnlyFreshlyMatchedSelectedAccount(t *testing.T) {
	for _, scenario := range []string{"matched", "other-account", "signed-out", "expired", "unauthorized"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			email := f.original.User.Username
			switch scenario {
			case "other-account":
				email = "other@example.test"
			case "signed-out":
				_ = f.store.Delete(accountSessionPrefix + f.account.identity.ServiceID)
				f.account.forgetToken()
			case "expired":
				f.original.ExpiresAt = time.Now().Add(-time.Second).Unix()
				_ = f.account.host.saveAccountSession(f.account.identity.ServiceID, f.record())
			case "unauthorized":
				f.currentCode = "p2p.user_unauthorized"
			}
			if _, err := f.reset(context.Background(), email); err != nil {
				t.Fatal("explicit password recovery failed", err)
			}
			if scenario == "matched" || scenario == "signed-out" {
				if _, exists, err := f.account.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
					t.Fatal("password reset retained the matched login", err)
				}
				f.account.directory.mu.Lock()
				token := f.account.directory.token
				f.account.directory.mu.Unlock()
				if token != "" {
					t.Fatal("reset kept matched local directory authority")
				}
			} else {
				f.assertRecord(t, f.record())
			}
		})
	}
}

func TestPasswordResetAuthTransportFailureAndInvalidCodeDoNotClearSession(t *testing.T) {
	for _, scenario := range []string{"preflight-network", "invalid-code"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			want := "p2p.password_reset_invalid"
			if scenario == "preflight-network" {
				want, f.currentCode = "p2p.server_unavailable", "p2p.server_unavailable"
			} else {
				f.resetCode = want
			}
			if _, err := f.reset(context.Background(), f.original.User.Username); err == nil || err.Error() != want {
				t.Fatal("password recovery changed its original refusal", err)
			}
			f.assertRecord(t, f.record())
			if scenario == "preflight-network" && len(f.paths) != 1 {
				t.Fatal("failed selected-account preflight still submitted a reset")
			}
		})
	}
}

func TestPasswordResetCannotDeleteSessionChangedWhileHTTPCompletes(t *testing.T) {
	for _, change := range []string{"new-token", "renewed-expiry"} {
		t.Run(change, func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			replacement := f.record()
			if change == "new-token" {
				replacement.Token = strings.Repeat("e", 64)
			} else {
				replacement.ExpiresAt = f.renewed.ExpiresAt
			}
			f.beforeReset = func() {
				if err := f.account.host.saveAccountSession(f.account.identity.ServiceID, replacement); err != nil {
					t.Error(err)
				}
			}
			if _, err := f.reset(context.Background(), f.original.User.Username); err == nil || err.Error() != "p2p.user_scope_mismatch" {
				t.Fatal("late password recovery cleared a replacement scope", err)
			}
			f.assertRecord(t, replacement)
		})
	}
}

type recoveryDeleteFailure struct{ *memoryStore }

func (store recoveryDeleteFailure) Delete(string) error { return secret.ErrDelete }

func TestPasswordResetFencesMatchingSessionEvenWhenProtectedDeletionFails(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	f.account.host.SetDeviceKeys(recoveryDeleteFailure{f.store})
	if _, err := f.reset(context.Background(), f.original.User.Username); !errors.Is(err, secret.ErrDelete) {
		t.Fatal("password reset hid protected cleanup failure", err)
	}
	f.assertRecord(t, f.record())
	if _, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token}); err == nil || err.Error() != "p2p.user_login_required" {
		t.Fatal("retained revoked record gained new local authority", err)
	}
	f.account.directory.mu.Lock()
	token := f.account.directory.token
	f.account.directory.mu.Unlock()
	if token != "" {
		t.Fatal("failed deletion preserved matched directory authority")
	}
}

func TestPasswordResetDeletionFailureCanRetryCleanupThenAuthenticateWithNewPassword(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	f.account.host.SetDeviceKeys(recoveryDeleteFailure{f.store})
	if _, err := f.reset(context.Background(), f.original.User.Username); !errors.Is(err, secret.ErrDelete) {
		t.Fatal("test did not retain the confirmed reset's explicit cleanup failure", err)
	}
	f.assertRecord(t, f.record())
	requestsAfterReset := len(f.paths)
	if _, err := f.handle(context.Background(), "user.renew", map[string]string{"token": strings.Repeat("f", 64)}); err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("unselected token borrowed exact local revocation", err)
	}
	if _, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token}); err == nil || err.Error() != "p2p.user_login_required" {
		t.Fatal("new renewal entry did not report the exact confirmed local revocation", err)
	}
	if len(f.paths) != requestsAfterReset {
		t.Fatal("revoked renewal reissued HTTP or replayed the reset code")
	}
	if err := f.account.host.deleteAccountSession(f.account.identity.ServiceID); !errors.Is(err, secret.ErrDelete) {
		t.Fatal("retry hid the still-unavailable protected cleanup", err)
	}
	// The explicit cleanup retry succeeds once the original provider recovers.
	f.account.host.SetDeviceKeys(f.store)
	if err := f.account.host.deleteAccountSession(f.account.identity.ServiceID); err != nil {
		t.Fatal("recovered provider could not remove the exact old session", err)
	}
	f.renewed.Token = strings.Repeat("e", 64)
	value, err := f.handle(context.Background(), "user.login", map[string]string{"username": f.original.User.Username, "password": "new-test-password-123"})
	if err != nil || value != f.renewed || f.renewed.User != f.original.User {
		t.Fatal("fresh password authentication could not establish the same account", err)
	}
	f.assertRecord(t, persistedAccountSession{Token: f.renewed.Token, ExpiresAt: f.renewed.ExpiresAt})
}

func TestUserRenewCannotRepublishAfterActualLogoutAdmission(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var released bool
	t.Cleanup(func() {
		if !released {
			close(release)
		}
	})
	f.beforeRenew = func() { close(entered); <-release }
	renewDone := make(chan error, 1)
	go func() {
		_, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token})
		renewDone <- err
	}()
	consumerAuthorityWait(t, "renewal HTTP", entered)
	logoutDone := make(chan error, 1)
	go func() {
		_, err := f.handle(context.Background(), "user.logout", map[string]string{"token": f.original.Token})
		logoutDone <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.account.host.bootstrapMu.Lock()
		owner := f.account.host.bootstrapSessionOwners[f.account.identity.ServiceID]
		revoked := owner != nil && owner.matches(f.record()) && owner.revoked
		f.account.host.bootstrapMu.Unlock()
		if revoked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("actual logout did not revoke the in-flight session")
		}
		runtime.Gosched()
	}
	close(release)
	released = true
	if err := <-renewDone; err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("late renewal restored a logged-out session", err)
	}
	if err := <-logoutDone; err != nil {
		t.Fatal("actual logout did not finish cleanup", err)
	}
	if _, exists, err := f.account.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
		t.Fatal("renewal recreated logged-out canonical session", err)
	}
}

func TestPasswordResetAdmissionRejectsMalformedSecretsBeforeHTTP(t *testing.T) {
	for _, change := range []string{"email", "code", "password-runes", "password-bytes", "unknown-field"} {
		t.Run(change, func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			request := map[string]string{"email": f.original.User.Username, "code": strings.Repeat("a", 64), "password": strings.Repeat("新", 12)}
			switch change {
			case "email":
				request["email"] = "invalid"
			case "code":
				request["code"] = strings.Repeat("A", 64)
			case "password-runes":
				request["password"] = strings.Repeat("新", 11)
			case "password-bytes":
				request["password"] = strings.Repeat("新", 25)
			case "unknown-field":
				request["token"] = f.original.Token
			}
			if _, err := f.handle(context.Background(), "user.resetPassword", request); err == nil || err.Error() != "p2p.invalid_request" {
				t.Fatal("malformed password recovery input was accepted", err)
			}
			if len(f.paths) != 0 {
				t.Fatal("malformed recovery input issued HTTP")
			}
		})
	}
}
