package helper

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/secret"
)

// This wire fixture exercises production TLS/client/helper owners. Independent
// coordinator/SQLite and native-provider acceptance lives in integration tests.
type accountRecoveryFixture struct {
	account                  *account
	store                    *memoryStore
	original, renewed        controlplane.UserSession
	currentCode, renewCode   string
	resetCode                string
	beforeRenew, beforeReset func()
	mu                       sync.Mutex
	paths                    []string
}

func newAccountRecoveryFixture(t *testing.T) *accountRecoveryFixture {
	t.Helper()
	f := &accountRecoveryFixture{}
	f.original = controlplane.UserSession{User: controlplane.User{UserID: "cccccccccccc", Username: "selected@example.test"}, Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	f.renewed = f.original
	f.renewed.ExpiresAt = time.Now().Add(30 * 24 * time.Hour).Unix()
	f.account, f.store = sessionAccount(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		var value any
		var code string
		switch r.URL.Path {
		case "/v1/user":
			code, value = f.currentCode, f.original.User
		case "/v1/session/renew":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+f.original.Token {
				t.Error("renewal lost its explicit bearer or method")
			}
			if f.beforeRenew != nil {
				f.beforeRenew()
			}
			code, value = f.renewCode, f.renewed
		case "/v1/password/reset":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "" {
				t.Error("password reset borrowed a selected login")
			}
			if f.beforeReset != nil {
				f.beforeReset()
			}
			code, value = f.resetCode, map[string]bool{"reset": true}
		case "/v1/logout":
			value = map[string]bool{"loggedOut": true}
		case "/v1/login":
			var request struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil || request.Username != f.original.User.Username || request.Password != "new-test-password-123" {
				code = "p2p.login_failed"
			}
			value = f.renewed
		case "/v1/networks":
			value = []controlplane.Network{}
		case "/v1/devices":
			value = []controlplane.DeviceEntry{}
		default:
			t.Error("unexpected recovery endpoint")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if code != "" {
			w.WriteHeader(http.StatusForbidden)
			value = map[string]string{"code": code}
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	f.account.host.accounts[f.account.identity.ServiceID] = f.account
	if err := f.account.host.saveAccountSession(f.account.identity.ServiceID, f.record()); err != nil {
		t.Fatal(err)
	}
	f.account.rememberToken(f.original.Token)
	return f
}

func (f *accountRecoveryFixture) record() persistedAccountSession {
	return persistedAccountSession{Token: f.original.Token, ExpiresAt: f.original.ExpiresAt}
}

func (f *accountRecoveryFixture) handle(ctx context.Context, method string, data any) (any, error) {
	body, _ := json.Marshal(data)
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: body})
	return f.account.host.Handle(ctx, method, payload)
}

func (f *accountRecoveryFixture) reset(ctx context.Context, email string) (any, error) {
	return f.handle(ctx, "user.resetPassword", passwordResetRequest{Email: email, Code: strings.Repeat("b", 64), Password: "new-test-password-123"})
}

func (f *accountRecoveryFixture) assertRecord(t *testing.T, expected persistedAccountSession) {
	t.Helper()
	current, exists, err := f.account.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current != expected {
		t.Fatal("recovery changed the selected durable record unexpectedly", err)
	}
}

func TestUserRenewCommitsOnlyServerExpiryBeforeReplyAndSurvivesHostRestart(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	value, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token})
	if err != nil || value != f.renewed {
		t.Fatal("renewal did not return the authenticated server session", err)
	}
	expected := persistedAccountSession{Token: f.original.Token, ExpiresAt: f.renewed.ExpiresAt}
	f.assertRecord(t, expected)
	restarted := New(context.Background())
	defer restarted.Close()
	restarted.SetDeviceKeys(f.store)
	current, exists, err := restarted.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current != expected {
		t.Fatal("new host could not read the canonical renewed session", err)
	}
}

func TestUserRenewRejectsMissingUnselectedOrMalformedInputWithoutHTTP(t *testing.T) {
	for _, change := range []string{"missing", "other-token", "extra-field"} {
		t.Run(change, func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			request := map[string]string{"token": f.original.Token}
			if change == "missing" {
				_ = f.store.Delete(accountSessionPrefix + f.account.identity.ServiceID)
			}
			if change == "other-token" {
				request["token"] = strings.Repeat("f", 64)
			}
			if change == "extra-field" {
				request["expiresAt"] = "invented"
			}
			if _, err := f.handle(context.Background(), "user.renew", request); err == nil {
				t.Fatal("invalid renewal was accepted")
			}
			if len(f.paths) != 0 {
				t.Fatal("invalid renewal issued HTTP")
			}
		})
	}
}

func TestUserRenewReconcilesLocallyExpiredRecordOnlyWhenServerStillAuthorizesIt(t *testing.T) {
	for _, authorized := range []bool{true, false} {
		t.Run(map[bool]string{true: "lost-renewal-reply", false: "server-expired"}[authorized], func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			f.original.ExpiresAt = time.Now().Add(-time.Hour).Unix()
			if err := f.account.host.saveAccountSession(f.account.identity.ServiceID, f.record()); err != nil {
				t.Fatal(err)
			}
			if err := f.account.confirmCurrentSession(f.original.Token); err == nil || err.Error() != "p2p.user_session_expired" {
				t.Fatal("ordinary current-user authority accepted local expiry", err)
			}
			if !authorized {
				f.currentCode = "p2p.user_unauthorized"
			}
			value, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token})
			if !authorized {
				if err == nil || err.Error() != "p2p.user_unauthorized" || value != nil {
					t.Fatal("real server expiry was bypassed", err)
				}
				f.assertRecord(t, f.record())
				return
			}
			if err != nil || value != f.renewed {
				t.Fatal("live server session could not reconcile a stale local expiry", err)
			}
			f.assertRecord(t, persistedAccountSession{Token: f.original.Token, ExpiresAt: f.renewed.ExpiresAt})
		})
	}
}

func TestRenewalScopeCannotAuthorizeOrdinarySelectedSessionWork(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	f.account.mu.Lock()
	defer f.account.mu.Unlock()
	renewal, err := f.account.captureRenewalSessionScopeLocked(context.Background(), f.record())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.account.captureSelectedSessionScopeLocked(renewal.Context(context.Background()), f.record()); err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("ordinary selected authority borrowed the renewal-only scope", err)
	}
}

func TestUserRenewRefusalsAndMalformedServerSessionPreserveCanonical(t *testing.T) {
	for _, change := range []string{"transport", "unauthorized", "unsupported", "token", "user", "shorter-expiry", "invalid-expiry"} {
		t.Run(change, func(t *testing.T) {
			f := newAccountRecoveryFixture(t)
			switch change {
			case "transport":
				f.renewCode = "p2p.server_unavailable"
			case "unauthorized":
				f.renewCode = "p2p.user_unauthorized"
			case "unsupported":
				f.renewCode = "p2p.unknown_operation"
			case "token":
				f.renewed.Token = strings.Repeat("f", 64)
			case "user":
				f.renewed.User.UserID = "dddddddddddd"
			case "shorter-expiry":
				f.renewed.ExpiresAt = f.original.ExpiresAt - 1
			case "invalid-expiry":
				f.renewed.ExpiresAt = time.Now().Add(-time.Second).Unix()
			}
			if _, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token}); err == nil {
				t.Fatal("failed or mismatched server renewal was accepted")
			}
			f.assertRecord(t, f.record())
			if len(f.paths) != 2 {
				t.Fatal("renewal failure silently retried another endpoint")
			}
		})
	}
}

type recoveryWriteFailure struct{ *memoryStore }

func (store recoveryWriteFailure) Set(string, []byte) error { return secret.ErrWrite }

func TestUserRenewProtectedWriteFailureDoesNotPublishSuccess(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	f.account.host.SetDeviceKeys(recoveryWriteFailure{f.store})
	if _, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token}); !errors.Is(err, secret.ErrWrite) {
		t.Fatal("renewal hid the failed protected write", err)
	}
	f.assertRecord(t, f.record())
}

func TestUserRenewCannotOverwriteCanonicalChangedDuringHTTP(t *testing.T) {
	f := newAccountRecoveryFixture(t)
	replacement := f.record()
	replacement.Token = strings.Repeat("e", 64)
	f.beforeRenew = func() {
		if err := f.account.host.saveAccountSession(f.account.identity.ServiceID, replacement); err != nil {
			t.Error(err)
		}
	}
	if _, err := f.handle(context.Background(), "user.renew", map[string]string{"token": f.original.Token}); err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("late renewal overwrote a replacement session", err)
	}
	f.assertRecord(t, replacement)
}
