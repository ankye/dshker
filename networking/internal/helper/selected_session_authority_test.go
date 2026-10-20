package helper

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

type selectedAuthorityCredentialBarrier struct {
	*logoutFailureStore
	key              string
	armed            atomic.Bool
	entered, release chan struct{}
}

func (store *selectedAuthorityCredentialBarrier) Get(key string) ([]byte, error) {
	value, err := store.logoutFailureStore.Get(key)
	if key == store.key && store.armed.CompareAndSwap(true, false) {
		close(store.entered)
		<-store.release
	}
	return value, err
}

func selectedAuthorityBarrier(t *testing.T, f *certificateFixture, path string, occurrence int) *consumerAuthorityBarrier {
	t.Helper()
	b := &consumerAuthorityBarrier{entered: make(chan struct{}), release: make(chan struct{}), logoutEntered: make(chan struct{}), logoutRelease: make(chan struct{})}
	t.Cleanup(func() { b.once.Do(func() { close(b.release) }); b.logoutOnce.Do(func() { close(b.logoutRelease) }) })
	var mu sync.Mutex
	seen := 0
	f.setHTTPObserver(func(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
		if r.URL.Path == "/v1/logout" {
			close(b.logoutEntered)
			select {
			case <-b.logoutRelease:
			case <-r.Context().Done():
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
			return
		}
		if r.URL.Path == path {
			mu.Lock()
			seen++
			gate := seen == occurrence
			mu.Unlock()
			if gate {
				close(b.entered)
				select {
				case <-b.release:
				case <-r.Context().Done():
					return
				}
			}
		}
		next(w, r)
	})
	return b
}

func TestSelectedSessionAuthorityLoginTailRejectsActualLogout(t *testing.T) {
	for _, stage := range []string{"catalog-user", "networks", "pairs", "identity", "activation"} {
		t.Run(stage, func(t *testing.T) {
			f, originalSession := bootstrapFixture(t)
			f.identityCode = "p2p.rate_limited"
			if f.host.RestoreOwnCredentials(context.Background()) != 0 || f.account.manager == nil || f.account.manager.CandidatesActive() {
				t.Fatal("auth fixture did not retain a real readonly Manager")
			}
			f.host.cancelBootstraps(f.account.identity.ServiceID)
			fresh := controlplane.UserSession{Token: strings.Repeat("b", 64), ExpiresAt: originalSession.ExpiresAt,
				User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
			f.mu.Lock()
			f.identityCode, f.loginSession, f.grantSessionToken = "", &fresh, fresh.Token
			beforeHello := len(f.hellos)
			f.mu.Unlock()
			paths := map[string]string{"catalog-user": "/v1/user", "networks": "/v1/networks", "pairs": "/v1/pairs", "identity": "/v2/pairs/identity"}
			occurrence := 1
			if stage == "catalog-user" {
				occurrence = 2 // confirmLogin's fresh read, then catalog's independent read.
			}
			b := selectedAuthorityBarrier(t, f, paths[stage], occurrence)
			if stage == "activation" {
				f.signalReadyGate = func() { close(b.entered); <-b.release }
			}
			f.host.SetDeviceKeys(&logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true})
			done := make(chan consumerAuthorityResult, 1)
			go func() {
				payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: json.RawMessage(`{"username":"selected@example.test","password":"isolated-new-session-password"}`)})
				value, err := f.host.Handle(context.Background(), "user.login", payload)
				done <- consumerAuthorityResult{value, err}
			}()
			consumerAuthorityWait(t, "fresh login authority await", b.entered)
			selected := persistedAccountSession{Token: fresh.Token, ExpiresAt: fresh.ExpiresAt}
			if current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || !exists || current != selected {
				t.Fatal("barrier preceded actual confirmation and durable readback")
			}
			logoutDone := consumerAuthorityRevoke(t, f, selected)
			b.once.Do(func() { close(b.release) })
			result := consumerAuthorityReceive(t, done)
			consumerAuthorityWait(t, "logout HTTP before local cleanup", b.logoutEntered)
			if result.err == nil || result.err.Error() != "p2p.user_scope_mismatch" || result.value != nil {
				t.Error("successful new authentication lost its selected owner during activation tail")
			}
			f.mu.Lock()
			hellos := len(f.hellos)
			f.mu.Unlock()
			if stage != "activation" && hellos != beforeHello {
				t.Error("revoked authentication dispatched new candidate WSS before logout cleanup")
			}
			if f.account.device.UserID != f.original.UserID {
				t.Error("selected authentication rewrote enrollment owner A")
			}
			consumerAuthorityFinishLogout(t, f, selected, b, logoutDone)
		})
	}
}

func TestSelectedSessionAuthorityActiveHeadlessRejectsLateCanonical(t *testing.T) {
	for _, change := range []string{"record-name", "actual-logout"} {
		t.Run(change, func(t *testing.T) {
			f, _ := canonicalFixture(t, 30*24*time.Hour)
			if err := canonicalOwnRestore(t, f, context.Background()); err != nil {
				t.Fatal(err)
			}
			stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
			if err != nil || !exists {
				t.Fatal("selected session missing")
			}
			f.loginSession = &controlplane.UserSession{Token: stored.Token, ExpiresAt: stored.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
			f.grantSessionToken = stored.Token
			f.host.SetDeviceKeys(&logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true})
			b := selectedAuthorityBarrier(t, f, "/v1/certificate-query", 1)
			done := make(chan consumerAuthorityResult, 1)
			go func() { done <- consumerAuthorityResult{err: canonicalOwnRestore(t, f, context.Background())} }()
			consumerAuthorityWait(t, "active headless canonical query", b.entered)
			var logoutDone <-chan error
			want := "p2p.identity_mismatch"
			if change == "record-name" {
				changed := f.original
				changed.Name = "independently replaced record"
				if err := f.host.SaveCredential(f.account.identity.ServiceID, changed, f.private); err != nil {
					t.Fatal(err)
				}
			} else {
				want = "p2p.user_scope_mismatch"
				logoutDone = consumerAuthorityRevoke(t, f, stored)
			}
			b.once.Do(func() { close(b.release) })
			result := consumerAuthorityReceive(t, done)
			if result.err == nil || result.err.Error() != want {
				t.Error("active headless maintenance bypassed canonical adoption scope", result.err)
			}
			if change == "record-name" {
				current, err := f.host.LoadCredential(f.account.identity.ServiceID)
				if err != nil || current.Name != "independently replaced record" {
					t.Error("late canonical result overwrote independently replaced credential")
				}
				clear(current.PrivateKey)
			} else {
				consumerAuthorityWait(t, "logout before cleanup", b.logoutEntered)
				consumerAuthorityFinishLogout(t, f, stored, b, logoutDone)
			}
		})
	}
}

func TestSelectedSessionAuthorityNetworkChoiceRejectsActualLogout(t *testing.T) {
	for _, method := range []string{"pairs.network_choices", "pairs.select_network"} {
		for _, path := range []string{"/v1/user", "/v1/networks", "/v1/pairs", "/v2/pairs/identity"} {
			t.Run(method+path, func(t *testing.T) {
				f, session, b, _ := consumerAuthorityFixture(t, path)
				saved, err := f.host.catalog.Inspect()
				if err != nil || saved == nil {
					t.Fatal("catalog missing")
				}
				var data any = map[string]any{}
				if method == "pairs.select_network" {
					data = map[string]string{"pairId": f.scopedIdentity.Target.DeviceID, "networkId": f.networkID, "userId": f.selectedUserID, "expectedRevision": saved.Revision}
				}
				payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": data})
				done := make(chan consumerAuthorityResult, 1)
				go func() {
					value, err := f.host.Handle(context.Background(), method, payload)
					done <- consumerAuthorityResult{value, err}
				}()
				consumerAuthorityWait(t, "network choice fresh authority", b.entered)
				logoutDone := consumerAuthorityRevoke(t, f, session)
				b.once.Do(func() { close(b.release) })
				result := consumerAuthorityReceive(t, done)
				consumerAuthorityWait(t, "logout HTTP before local cleanup", b.logoutEntered)
				if result.err == nil || result.err.Error() != "p2p.user_scope_mismatch" || result.value != nil {
					t.Error("network choice granted late revoked-session authority")
				}
				current, err := f.host.catalog.Inspect()
				if err != nil || current.Revision != saved.Revision {
					t.Error("late selection changed durable catalog before logout cleanup")
				}
				consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
			})
		}
	}
}

func TestSelectedSessionAuthorityCatalogBackgroundKeepsCapturedOwner(t *testing.T) {
	for _, origin := range []string{"lifetime-background", "after-write"} {
		for _, change := range []string{"revoked", "independent-generation"} {
			t.Run(origin+"/"+change, func(t *testing.T) {
				f, session, b, _ := consumerAuthorityFixture(t, "/v2/pairs/identity")
				saved, err := f.host.catalog.Inspect()
				if err != nil {
					t.Fatal(err)
				}
				f.mu.Lock()
				f.scopedIdentity.Target.Name = "freshly authorized new display name"
				beforeHello := len(f.hellos)
				f.mu.Unlock()
				done := make(chan consumerAuthorityResult, 1)
				if origin == "after-write" {
					f.account.mu.Lock()
					f.host.bootstrapMu.Lock()
					generation := f.host.bootstrapGeneration[f.account.identity.ServiceID]
					f.host.bootstrapMu.Unlock()
					ctx := withBootstrapLocalFence(context.Background(), f.account.identity.ServiceID, generation, nil, false)
					err = f.account.refreshCatalogAfterWrite(ctx)
					f.account.mu.Unlock()
					if err != nil {
						t.Fatal(err)
					}
				} else {
					go func() {
						revision, err := f.account.refreshCatalog(f.account.maintenanceLifetime())
						done <- consumerAuthorityResult{revision, err}
					}()
				}
				consumerAuthorityWait(t, "background fresh scoped identity", b.entered)
				var logoutDone <-chan error
				if change == "revoked" {
					logoutDone = consumerAuthorityRevoke(t, f, session)
				} else {
					f.host.cancelBootstraps(f.account.identity.ServiceID)
				}
				b.once.Do(func() { close(b.release) })
				if origin == "lifetime-background" {
					result := consumerAuthorityReceive(t, done)
					if change == "revoked" && (result.err == nil || result.err.Error() != "p2p.user_scope_mismatch") || change == "independent-generation" && result.err != nil {
						t.Error("background confused selected identity with unrelated worker generation", result.err)
					}
				}
				if change == "revoked" {
					consumerAuthorityWait(t, "logout before its local cleanup", b.logoutEntered)
				} else {
					// The read holds account.mu until its guarded store commit.
					f.account.mu.Lock()
					f.account.mu.Unlock()
				}
				current, err := f.host.catalog.Inspect()
				if err != nil || change == "revoked" && current.Revision != saved.Revision || change == "independent-generation" && current.Revision == saved.Revision {
					t.Error("background store publication escaped or lost its exact owner", err)
				}
				f.mu.Lock()
				hellos := len(f.hellos)
				f.mu.Unlock()
				if hellos != beforeHello {
					t.Error("background catalog unnecessarily replaced existing candidate registration")
				}
				if logoutDone != nil {
					consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
				}
			})
		}
	}
}

func TestSelectedSessionAuthorityPendingPublicationRejectsActualLogout(t *testing.T) {
	f, session := authRecoveryFixture(t) // real original certificate crossed NotAfter.
	b := selectedAuthorityBarrier(t, f, "/not-an-authority-route", 1)
	store := &selectedAuthorityCredentialBarrier{logoutFailureStore: &logoutFailureStore{memoryStore: f.store,
		sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true},
		key: credentialKey(f.account.identity.ServiceID), entered: make(chan struct{}), release: make(chan struct{})}
	f.host.SetDeviceKeys(store)
	var released sync.Once
	t.Cleanup(func() { released.Do(func() { close(store.release) }) })
	observe := f.httpObserver()
	f.setHTTPObserver(func(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
		if r.URL.Path == "/v1/user" {
			// Transport was selected before dispatch. The next original-record
			// Get is post-confirmation activation admission, not an HTTP mock.
			store.armed.Store(true)
		}
		observe(w, r, next)
	})
	done := make(chan consumerAuthorityResult, 1)
	go func() {
		value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "isolated-expired-auth-password"})
		done <- consumerAuthorityResult{value, err}
	}()
	consumerAuthorityWait(t, "post-auth original-record Get", store.entered)
	selected := persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}
	logoutDone := consumerAuthorityRevoke(t, f, selected)
	released.Do(func() { close(store.release) })
	result := consumerAuthorityReceive(t, done)
	consumerAuthorityWait(t, "logout HTTP before local cleanup", b.logoutEntered)
	if result.err == nil || result.err.Error() != "p2p.user_scope_mismatch" || result.value != nil {
		t.Error("revoked post-auth admission returned successful pending authentication")
	}
	if f.account.activationPending != nil || f.account.activationSource != nil {
		t.Error("revoked authority published new pending provenance before logout cleanup")
	}
	consumerAuthorityFinishLogout(t, f, selected, b, logoutDone)
}
