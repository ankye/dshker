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
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/secret"
)

func sessionAccount(t *testing.T, handler http.Handler) (*account, *memoryStore) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	base, err := controlplane.New(controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/signals", STUNAddress: "127.0.0.1:3478"}, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(base.Close)
	host := New(context.Background())
	t.Cleanup(host.Close)
	store := newMemoryStore()
	host.SetDeviceKeys(store)
	return &account{host: host, base: base, httpPhase: accountHTTPSetup, identity: controlplane.Identity{ServiceID: "aaaaaaaaaaaa"}, device: controlplane.Device{UserID: "bbbbbbbbbbbb"}}, store
}

func TestSelectedSessionRestoresActualAccountWithoutDeviceOwnerSubstitution(t *testing.T) {
	user := controlplane.User{UserID: "cccccccccccc", Username: "current@example.test"}
	token := strings.Repeat("a", 64)
	account, _ := sessionAccount(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/user" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("selected session was not authenticated")
		}
		json.NewEncoder(w).Encode(user)
	}))
	if err := account.host.saveAccountSession(account.identity.ServiceID, persistedAccountSession{Token: token, ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	selected, err := account.selectedAccount(context.Background())
	if err != nil || selected != user.UserID || selected == account.device.UserID {
		t.Fatalf("selected account = %q, %v", selected, err)
	}
}

func TestMissingSelectedSessionIsSignedOutAndNeverQueriesDeviceOwner(t *testing.T) {
	account, _ := sessionAccount(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("missing login session must not query as the device owner")
	}))
	if selected, err := account.selectedAccount(context.Background()); err != nil || selected != "" {
		t.Fatalf("missing selected session = %q, %v", selected, err)
	}
}

func TestSelectedSessionReadbackChangeCannotPublishOldDirectoryAuthority(t *testing.T) {
	var account *account
	var changed persistedAccountSession
	account, _ = sessionAccount(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := account.host.saveAccountSession(account.identity.ServiceID, changed); err != nil {
			t.Error(err)
		}
		json.NewEncoder(w).Encode(controlplane.User{UserID: "cccccccccccc", Username: "old@example.test"})
	}))
	first := persistedAccountSession{Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	changed = first
	changed.Token = strings.Repeat("b", 64)
	if err := account.host.saveAccountSession(account.identity.ServiceID, first); err != nil {
		t.Fatal(err)
	}
	if selected, err := account.selectedAccount(context.Background()); selected != "" || err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("late CurrentUser adopted a changed session", selected, err)
	}
	account.directory.mu.Lock()
	token := account.directory.token
	account.directory.mu.Unlock()
	if token != "" {
		t.Fatal("rejected selected-session lookup published old authority")
	}
}

func TestSelectedSessionReadAndNetworkFailuresRemainExplicit(t *testing.T) {
	for _, scenario := range []string{"corrupt", "provider", "network", "expired"} {
		t.Run(scenario, func(t *testing.T) {
			account, store := sessionAccount(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "network" {
					w.WriteHeader(http.StatusServiceUnavailable)
					json.NewEncoder(w).Encode(map[string]string{"code": "p2p.server_unavailable"})
					return
				}
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(map[string]string{"code": "p2p.user_unauthorized"})
			}))
			session := persistedAccountSession{Token: strings.Repeat("d", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
			if scenario == "expired" {
				session.ExpiresAt = time.Now().Add(-time.Second).Unix()
			}
			if err := account.host.saveAccountSession(account.identity.ServiceID, session); err != nil {
				t.Fatal(err)
			}
			key := accountSessionPrefix + account.identity.ServiceID
			if scenario == "corrupt" {
				store.Set(key, []byte(`{"token":"short"}`))
			}
			if scenario == "provider" {
				store.failed = true
			}
			selected, err := account.selectedAccount(context.Background())
			if err == nil || selected != "" {
				t.Fatalf("%s hid failed restore as an account: %q, %v", scenario, selected, err)
			}
			if scenario == "provider" && !errors.Is(err, secret.ErrRead) {
				t.Fatal("provider refusal was not typed", err)
			}
			store.failed = false
			if _, err := store.Get(key); err != nil {
				t.Fatal("failed restore erased the original record", err)
			}
		})
	}
}

func TestCurrentSessionRequiresExistingMatchingRecordAndLogoutDeletesIt(t *testing.T) {
	account, _ := sessionAccount(t, http.NotFoundHandler())
	token := strings.Repeat("e", 64)
	if err := account.confirmCurrentSession(token); err == nil || err.Error() != "p2p.user_login_required" {
		t.Fatal("current invented expiry for a new token", err)
	}
	if err := account.host.saveAccountSession(account.identity.ServiceID, persistedAccountSession{Token: token, ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	if err := account.confirmCurrentSession(strings.Repeat("f", 64)); err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("current adopted an unrelated token", err)
	}
	if err := account.confirmCurrentSession(token); err != nil {
		t.Fatal(err)
	}
	if err := account.host.deleteAccountSession(account.identity.ServiceID); err != nil {
		t.Fatal(err)
	}
	if _, exists, err := account.host.readAccountSession(account.identity.ServiceID); err != nil || exists {
		t.Fatal("logout retained selected-session authority", err)
	}
}

func TestRejectedCurrentTokenCannotPublishDirectoryAuthority(t *testing.T) {
	var requests int
	account, _ := sessionAccount(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		// Both tokens could be valid server credentials. Only the durable token
		// may confirm the selected account; the other must fail before HTTP.
		json.NewEncoder(w).Encode(controlplane.User{UserID: "cccccccccccc", Username: "other@example.test"})
	}))
	token := strings.Repeat("a", 64)
	if err := account.host.saveAccountSession(account.identity.ServiceID, persistedAccountSession{Token: token, ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	account.rememberToken(token)
	account.directory.view = DirectoryView{ServiceID: account.identity.ServiceID, Known: true, Revision: 4}
	before := account.snapshot(account.identity.ServiceID)
	_, err := account.host.manage(context.Background(), account, "user.current", json.RawMessage(`{"token":"`+strings.Repeat("b", 64)+`"}`))
	if err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("unrecorded current token was adopted", err)
	}
	if requests != 0 || account.directory.token != token || account.snapshot(account.identity.ServiceID).Revision != before.Revision || !account.snapshot(account.identity.ServiceID).Known {
		t.Fatal("rejected current-user call changed the directory token/snapshot or queried authority")
	}
}
