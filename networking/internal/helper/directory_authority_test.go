package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/secret"
)

type consumerAuthorityResult struct {
	value any
	err   error
}

// These barriers observe real TLS and actual Host logout admission. Neither the
// original account nor any native credential provider participates in this run.
type consumerAuthorityBarrier struct {
	mu                           sync.Mutex
	paths                        []string
	entered, release             chan struct{}
	logoutEntered, logoutRelease chan struct{}
	once, logoutOnce             sync.Once
}

func consumerAuthorityFixture(t *testing.T, path string) (*certificateFixture, persistedAccountSession, *consumerAuthorityBarrier, *announceRecorder) {
	t.Helper()
	f, session := bootstrapFixture(t)
	f.loginSession = &controlplane.UserSession{Token: session.Token, ExpiresAt: session.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.grantSessionToken = session.Token
	if count := f.host.RestoreOwnCredentials(context.Background()); count != 1 {
		t.Fatal("consumer fixture did not establish the original real TLS selected owner")
	}
	recorder := newAnnounceRecorder()
	f.host.BindMain(recorder)
	f.host.SetDeviceKeys(&logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true})
	b := &consumerAuthorityBarrier{entered: make(chan struct{}), release: make(chan struct{}), logoutEntered: make(chan struct{}), logoutRelease: make(chan struct{})}
	t.Cleanup(func() { b.once.Do(func() { close(b.release) }); b.logoutOnce.Do(func() { close(b.logoutRelease) }) })
	f.setHTTPObserver(func(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
		b.mu.Lock()
		b.paths = append(b.paths, r.URL.Path)
		b.mu.Unlock()
		if r.URL.Path == "/v1/logout" {
			if r.Header.Get("Authorization") != "Bearer "+session.Token || len(r.TLS.VerifiedChains) == 0 {
				t.Error("actual logout did not retain verified original mTLS and selected Bearer")
			}
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
			close(b.entered)
			select {
			case <-b.release:
			case <-r.Context().Done():
				return
			}
		}
		next(w, r)
	})
	return f, session, b, recorder
}

func consumerAuthorityWait(t *testing.T, label string, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal(label + " did not settle")
	}
}

func consumerAuthorityRevoke(t *testing.T, f *certificateFixture, session persistedAccountSession) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := f.host.Handle(context.Background(), "user.logout", logoutPayload(f, session.Token))
		done <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.host.bootstrapMu.Lock()
		owner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
		revoked := owner != nil && owner.matches(session) && owner.revoked
		f.host.bootstrapMu.Unlock()
		if revoked {
			return done
		}
		if !time.Now().Before(deadline) {
			t.Fatal("actual logout did not publish exact selected-session revocation")
		}
		runtime.Gosched()
	}
}

func consumerAuthorityFinishLogout(t *testing.T, f *certificateFixture, session persistedAccountSession, b *consumerAuthorityBarrier, done <-chan error) {
	t.Helper()
	b.logoutOnce.Do(func() { close(b.logoutRelease) })
	select {
	case err := <-done:
		if err == nil || err.Error() != "p2p.rate_limited" || !errors.Is(err, secret.ErrDelete) {
			t.Error("logout did not retain real HTTP refusal and durable deletion failure")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("actual logout cleanup did not join")
	}
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current != session {
		t.Fatal("failure composition did not retain the original durable session")
	}
	f.mu.Lock()
	remoteRevoked := f.logoutRevoked
	f.mu.Unlock()
	if remoteRevoked {
		t.Fatal("HTTP 429 was incorrectly recorded as remote logout acknowledgement")
	}
}

func consumerAuthorityReceive(t *testing.T, done <-chan consumerAuthorityResult) consumerAuthorityResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("authority consumer did not join after the real TLS barrier")
		return consumerAuthorityResult{}
	}
}

func TestDirectoryAuthorityLogoutWinsAfterEveryRealTLSRead(t *testing.T) {
	for _, origin := range []string{"explicit", "lifetime-background"} {
		for _, stage := range []string{"networks", "members", "devices"} {
			t.Run(origin+"/"+stage, func(t *testing.T) {
				f, session, b, recorder := consumerAuthorityFixture(t, "/not-yet-selected")
				paths := map[string]string{"networks": "/v1/networks", "members": "/v1/networks/" + f.networkID + "/devices", "devices": "/v1/devices"}
				// The wrapper reads this immutable captured path only after dispatch.
				observe := f.httpObserver()
				f.setHTTPObserver(func(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
					if r.URL.Path == paths[stage] {
						close(b.entered)
						select {
						case <-b.release:
						case <-r.Context().Done():
							return
						}
					}
					observe(w, r, next)
				})
				before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
				done := make(chan consumerAuthorityResult, 1)
				go func() {
					var value any
					var err error
					if origin == "explicit" {
						payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: json.RawMessage(`{}`)})
						value, err = f.host.Handle(context.Background(), "directory.refresh", payload)
					} else {
						ctx, cancel := context.WithTimeout(f.account.maintenanceLifetime(), directoryRefreshTimeout)
						defer cancel()
						value, err = f.account.refreshDirectory(ctx)
					}
					done <- consumerAuthorityResult{value, err}
				}()
				consumerAuthorityWait(t, "directory TLS read", b.entered)
				logoutDone := consumerAuthorityRevoke(t, f, session)
				b.once.Do(func() { close(b.release) })
				result := consumerAuthorityReceive(t, done)
				consumerAuthorityWait(t, "logout HTTP before its own cleanup", b.logoutEntered)
				if result.err == nil || result.err.Error() != "p2p.user_scope_mismatch" {
					t.Error("late directory read did not preserve its revoked selected owner")
				}
				after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
				if !bytes.Equal(before, after) || len(recorder.announcements()) != 0 {
					t.Error("directory view/revision/announcement escaped before logout cleanup")
				}
				b.mu.Lock()
				calls := append([]string(nil), b.paths...)
				b.mu.Unlock()
				if len(calls) != map[string]int{"networks": 2, "members": 3, "devices": 4}[stage] {
					t.Error("revoked directory consumer continued to a later endpoint", calls)
				}
				consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
			})
		}
	}
}

func TestDirectoryAuthorityReadToPublishTailCannotRestoreLoggedOutView(t *testing.T) {
	f, session, b, recorder := consumerAuthorityFixture(t, "/no-gate")
	read, err := f.account.readDirectoryScoped(context.Background())
	if err != nil || !read.view.Known {
		t.Fatal("fresh real TLS directory did not reach the unlocked publication boundary", err)
	}
	logoutDone := consumerAuthorityRevoke(t, f, session)
	consumerAuthorityWait(t, "logout HTTP", b.logoutEntered)
	consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
	before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
	announcements := len(recorder.announcements())
	if f.account.snapshot(f.account.identity.ServiceID).Known {
		t.Fatal("actual logout did not clear its maintained directory")
	}
	_, err = f.account.publishDirectory(context.Background(), read)
	certificateError(t, err, "p2p.user_scope_mismatch")
	after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
	if !bytes.Equal(before, after) || len(recorder.announcements()) != announcements {
		t.Fatal("unlocked late result restored a logged-out directory or announced it")
	}
}

func TestDirectoryAuthorityAfterWriteKeepsCapturedOwner(t *testing.T) {
	for _, change := range []string{"revoked", "session-replaced", "independent-generation"} {
		t.Run(change, func(t *testing.T) {
			f, session, b, recorder := consumerAuthorityFixture(t, "/no-gate")
			serviceID := f.account.identity.ServiceID
			f.host.bootstrapMu.Lock()
			if f.host.bootstrapGeneration == nil {
				f.host.bootstrapGeneration = make(map[string]uint64)
			}
			generation := f.host.bootstrapGeneration[serviceID]
			f.host.bootstrapMu.Unlock()
			ctx := withBootstrapLocalFence(context.Background(), serviceID, generation, nil, false)
			f.account.mu.Lock()
			scope, err := f.account.captureSelectedSessionScopeLocked(ctx, session)
			f.account.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			ctx = scope.Context(ctx)
			if change == "revoked" {
				logoutDone := consumerAuthorityRevoke(t, f, session)
				consumerAuthorityWait(t, "logout HTTP", b.logoutEntered)
				consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
			} else if change == "session-replaced" {
				replacement := session
				replacement.Token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				if err := f.host.saveAccountSession(serviceID, replacement); err != nil {
					t.Fatal(err)
				}
			}
			before := len(recorder.announcements())
			f.account.mu.Lock()
			err = f.account.refreshAfterWrite(ctx)
			if change == "independent-generation" {
				// The dispatched read has not acquired account.mu yet. The completed
				// caller's generation moves, but its selected session remains exact.
				f.host.bootstrapMu.Lock()
				f.host.bootstrapGeneration[serviceID]++
				f.host.bootstrapMu.Unlock()
			}
			f.account.mu.Unlock()
			if change == "independent-generation" {
				if err != nil {
					t.Fatal(err)
				}
				consumerAuthorityWait(t, "AfterWrite fresh directory publication", recorder.seen)
				if !f.account.snapshot(serviceID).Known || len(recorder.announcements()) != before+1 {
					t.Fatal("ordinary background session was coupled to an unrelated worker generation")
				}
				certificateError(t, checkBootstrapContext(ctx), "p2p.user_scope_mismatch")
				f.host.bootstrapMu.Lock()
				current := f.host.bootstrapSessionOwners[serviceID] == scope.owner && !scope.owner.revoked
				f.host.bootstrapMu.Unlock()
				if !current {
					t.Fatal("AfterWrite minted a replacement selected owner")
				}
			} else {
				certificateError(t, err, "p2p.user_scope_mismatch")
				if len(recorder.announcements()) != before {
					t.Fatal("rejected AfterWrite emitted a late directory projection")
				}
			}
		})
	}
}
