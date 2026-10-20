package helper

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

func captureScopeForTest(t *testing.T, f *certificateFixture, ctx context.Context) *selectedSessionScope {
	t.Helper()
	f.account.mu.Lock()
	defer f.account.mu.Unlock()
	scope, err := f.account.selectedSessionScopeLocked(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func TestSelectedSessionScopeContextDoesNotSelfChain(t *testing.T) {
	f, _ := canonicalFixture(t, 30*24*time.Hour)
	priorCalls := 0
	ctx := context.WithValue(context.Background(), bootstrapGuardKey{}, func() error { priorCalls++; return nil })
	scope := captureScopeForTest(t, f, ctx)
	priorCalls = 0
	ctx = scope.Context(scope.Context(ctx))
	if err := checkBootstrapContext(ctx); err != nil || priorCalls != 1 {
		t.Fatal("same scope context recursively chained or lost immutable prior", err, priorCalls)
	}
	if err := scope.Check(ctx); err != nil || priorCalls != 1 {
		t.Fatal("Check invoked prior instead of examining only its own scope", err, priorCalls)
	}
	strongerCalls := 0
	stronger := context.WithValue(ctx, bootstrapGuardKey{}, func() error {
		strongerCalls++
		return errors.New("p2p.identity_mismatch")
	})
	stronger = scope.Context(stronger)
	if err := checkBootstrapContext(stronger); err == nil || err.Error() != "p2p.identity_mismatch" || strongerCalls != 1 {
		t.Fatal("reinstalling the same scope erased a later canonical guard")
	}
	published := false
	err := scope.Publish(stronger, func() error { published = true; return nil })
	if err == nil || err.Error() != "p2p.identity_mismatch" || published || strongerCalls != 2 {
		t.Fatal("Publish bypassed a later canonical guard", err, published, strongerCalls)
	}
	missing := context.WithValue(context.Background(), selectedSessionScopeKey{}, scope)
	if err := scope.Publish(missing, func() error { published = true; return nil }); err == nil || published {
		t.Fatal("scope without its guard silently became an unguarded publication")
	}
	if background, err := scope.Background(stronger); err == nil || background != nil {
		t.Fatal("a later denied guard became an authorized AfterWrite derivation")
	}
	foreign := *scope
	foreignContext := foreign.Context(context.Background())
	if err := scope.Publish(foreignContext, func() error { published = true; return nil }); err == nil || published {
		t.Fatal("a different installed scope was treated as absent")
	}
	if background, err := scope.Background(foreignContext); err == nil || background != nil {
		t.Fatal("AfterWrite derived through a different installed scope")
	}
}

func TestSelectedSessionScopePublicationRechecksTypedFences(t *testing.T) {
	for _, scenario := range []string{"generation", "exact-job", "background-independent-generation", "background-revoked", "owner-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			f, _ := canonicalFixture(t, 30*24*time.Hour)
			id := f.account.identity.ServiceID
			job := &bootstrapJob{serviceID: id}
			f.host.bootstrapMu.Lock()
			f.host.bootstraps = map[string]*bootstrapJob{id: job}
			f.host.bootstrapMu.Unlock()
			t.Cleanup(func() {
				f.host.bootstrapMu.Lock()
				f.host.bootstraps = nil
				f.host.bootstrapMu.Unlock()
			})
			mutate := false
			ctx := withBootstrapLocalFence(context.Background(), id, 0, job, true)
			ctx = context.WithValue(ctx, bootstrapGuardKey{}, func() error {
				if mutate {
					f.host.bootstrapMu.Lock()
					switch scenario {
					case "generation":
						f.host.bootstrapGeneration = map[string]uint64{id: 1}
					case "exact-job":
						f.host.bootstraps[id] = &bootstrapJob{serviceID: id}
					case "owner-replaced":
						f.host.bootstrapSessionOwners[id] = &bootstrapSessionOwner{}
					}
					f.host.bootstrapMu.Unlock()
				}
				return nil
			})
			scope := captureScopeForTest(t, f, ctx)
			if strings.HasPrefix(scenario, "background-") {
				var err error
				scope, err = scope.Background(ctx)
				if err != nil {
					t.Fatal(err)
				}
				f.host.bootstrapMu.Lock()
				f.host.bootstrapGeneration = map[string]uint64{id: 1}
				if scenario == "background-revoked" {
					scope.owner.revoked = true
				}
				f.host.bootstrapMu.Unlock()
			}
			mutate = true
			published := false
			publication := scope.Context(context.Background())
			if !strings.HasPrefix(scenario, "background-") {
				// The earlier opaque check has passed; mutate only after it. The
				// typed fence must independently reject under Publish's mutex.
				publication = context.WithValue(publication, bootstrapGuardKey{}, func() error {
					mutate = false
					if err := scope.Check(context.Background()); err != nil {
						return err
					}
					mutate = true
					return scope.priorGuard()
				})
			}
			err := scope.Publish(publication, func() error { published = true; return nil })
			wantSuccess := scenario == "background-independent-generation"
			if wantSuccess && (err != nil || !published) || !wantSuccess && (err == nil || err.Error() != "p2p.user_scope_mismatch" || published) {
				t.Fatal("scope commit did not retain independent session/job axes", err, published)
			}
			// These are unscheduled local fence objects, never runnable jobs.
			f.host.bootstrapMu.Lock()
			f.host.bootstraps = nil
			f.host.bootstrapMu.Unlock()
		})
	}
}

func TestSelectedSessionScopeSignedOutPresenceBoundary(t *testing.T) {
	for _, scenario := range []string{"absent-to-present", "present-to-absent", "nonempty-account", "expired-is-not-absence", "provider-error", "corrupt-record"} {
		t.Run(scenario, func(t *testing.T) {
			f, _ := canonicalFixture(t, 30*24*time.Hour)
			id := f.account.identity.ServiceID
			request := deviceRestoreRequest{Pins: []controlplane.PairIdentity{}}
			if scenario == "absent-to-present" || scenario == "nonempty-account" {
				if err := f.host.deleteAccountSession(id); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "nonempty-account" {
				request.AccountUserID = f.selectedUserID
			}
			if scenario == "expired-is-not-absence" {
				if err := f.host.saveAccountSession(id, persistedAccountSession{Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(-time.Second).Unix()}); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "provider-error" {
				f.store.mu.Lock()
				f.store.failed = true
				f.store.mu.Unlock()
				t.Cleanup(func() { f.store.mu.Lock(); f.store.failed = false; f.store.mu.Unlock() })
			}
			if scenario == "corrupt-record" {
				if err := f.store.Set(accountSessionPrefix+id, []byte("null")); err != nil {
					t.Fatal(err)
				}
			}
			f.account.mu.Lock()
			var scope *selectedSessionScope
			var err error
			if scenario == "present-to-absent" {
				scope, err = f.account.selectedSessionScopeLocked(context.Background())
			} else {
				scope, err = f.account.captureSignedOutRestoreScopeLocked(context.Background(), request)
			}
			f.account.mu.Unlock()
			if scenario == "nonempty-account" || scenario == "expired-is-not-absence" || scenario == "provider-error" || scenario == "corrupt-record" {
				if err == nil || scope != nil {
					t.Fatal("invalid or expired authority became signed-out scope")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "present-to-absent" {
				err = f.host.deleteAccountSession(id)
			} else {
				err = f.host.saveAccountSession(id, persistedAccountSession{Token: strings.Repeat("b", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()})
			}
			if err != nil {
				t.Fatal(err)
			}
			published := false
			err = scope.Publish(context.Background(), func() error { published = true; return nil })
			if err == nil || err.Error() != "p2p.user_scope_mismatch" || published {
				t.Fatal("scope accepted a session-presence direction change", err, published)
			}
		})
	}
}

func TestSelectedSessionScopeLifecycleRejectsBeforePublication(t *testing.T) {
	for _, change := range []string{"caller-cancel", "host-close", "service-removal", "account-replacement"} {
		t.Run(change, func(t *testing.T) {
			f, _ := canonicalFixture(t, 30*24*time.Hour)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			scope := captureScopeForTest(t, f, ctx)
			switch change {
			case "caller-cancel":
				cancel()
			case "host-close":
				f.host.Close()
			case "service-removal":
				f.host.ForgetService(f.account.identity.ServiceID)
			case "account-replacement":
				f.host.mu.Lock()
				f.host.accounts[f.account.identity.ServiceID] = &account{host: f.host}
				f.host.mu.Unlock()
				t.Cleanup(f.account.base.Close)
			}
			published := false
			err := scope.Publish(scope.Context(ctx), func() error { published = true; return nil })
			if err == nil || published {
				t.Fatal("lifecycle loss admitted selected authority publication", err, published)
			}
		})
	}
}
