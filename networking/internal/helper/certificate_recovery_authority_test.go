package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

func TestCertificateRecoveryAuthorityLogoutWinsAfterEveryRealTLSRead(t *testing.T) {
	for _, stage := range []string{"user", "networks", "members"} {
		t.Run(stage, func(t *testing.T) {
			f, session, b, recorder := consumerAuthorityFixture(t, "/not-yet-selected")
			paths := map[string]string{"user": "/v1/user", "networks": "/v1/networks", "members": "/v1/networks/" + f.networkID + "/devices"}
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
				data, _ := json.Marshal(map[string]string{"deviceId": f.original.DeviceID, "token": session.Token})
				payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
				value, err := f.host.Handle(context.Background(), "device.certificate_recovery_scope", payload)
				done <- consumerAuthorityResult{value, err}
			}()
			consumerAuthorityWait(t, "recovery scope TLS read", b.entered)
			logoutDone := consumerAuthorityRevoke(t, f, session)
			b.once.Do(func() { close(b.release) })
			result := consumerAuthorityReceive(t, done)
			consumerAuthorityWait(t, "logout HTTP before its own cleanup", b.logoutEntered)
			if result.err == nil || result.err.Error() != "p2p.user_scope_mismatch" || result.value != nil {
				t.Error("late named recovery owner returned a revoked issuance projection")
			}
			after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
			if !bytes.Equal(before, after) || len(recorder.announcements()) != 0 {
				t.Error("named recovery projection changed ordinary directory state")
			}
			b.mu.Lock()
			calls := append([]string(nil), b.paths...)
			b.mu.Unlock()
			if len(calls) != map[string]int{"user": 2, "networks": 3, "members": 4}[stage] {
				t.Error("revoked recovery projection continued to a later endpoint", calls)
			}
			f.mu.Lock()
			if f.grants != 0 || f.recoveries != 0 || f.renewals != 0 || len(f.hellos) != 2 {
				t.Error("read-only recovery projection issued a certificate or advertised WSS")
			}
			f.mu.Unlock()
			consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
		})
	}
}

func TestCertificateRecoveryAuthorityRetainedRevocationRefusesBeforeHTTP(t *testing.T) {
	f, session, b, recorder := consumerAuthorityFixture(t, "/no-gate")
	logoutDone := consumerAuthorityRevoke(t, f, session)
	consumerAuthorityWait(t, "logout HTTP", b.logoutEntered)
	consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
	before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
	announcements := len(recorder.announcements())
	data, _ := json.Marshal(map[string]string{"deviceId": f.original.DeviceID, "token": session.Token})
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
	value, err := f.host.Handle(context.Background(), "device.certificate_recovery_scope", payload)
	certificateError(t, err, "p2p.user_scope_mismatch")
	b.mu.Lock()
	requests := len(b.paths)
	b.mu.Unlock()
	after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
	if value != nil || requests != 1 || !bytes.Equal(before, after) || len(recorder.announcements()) != announcements {
		t.Fatal("retained revoked session dispatched recovery HTTP or returned local authority")
	}
}

func TestCertificateRecoveryAuthorityGenuineNewLoginHasIndependentOwner(t *testing.T) {
	f, session, b, _ := consumerAuthorityFixture(t, "/no-gate")
	logoutDone := consumerAuthorityRevoke(t, f, session)
	consumerAuthorityWait(t, "logout HTTP", b.logoutEntered)
	consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
	f.host.bootstrapMu.Lock()
	oldOwner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	f.host.bootstrapMu.Unlock()
	newSession := controlplane.UserSession{Token: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", ExpiresAt: session.ExpiresAt + 1, User: f.loginSession.User}
	f.mu.Lock()
	f.loginSession, f.grantSessionToken = &newSession, newSession.Token
	f.mu.Unlock()
	value, err := authHandle(f, "user.login", map[string]string{"username": newSession.User.Username, "password": "test-only-password"})
	if err != nil || value.(controlplane.UserSession).Token != newSession.Token {
		t.Fatal("actual new login did not establish a genuinely new durable session", err)
	}
	data, _ := json.Marshal(map[string]string{"deviceId": f.original.DeviceID, "token": newSession.Token})
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
	value, err = f.host.Handle(context.Background(), "device.certificate_recovery_scope", payload)
	if err != nil || value.(certificateRecoveryScope).User != newSession.User {
		t.Fatal("named recovery scope inherited the old session's local revocation", err)
	}
	f.host.bootstrapMu.Lock()
	newOwner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	current := oldOwner != nil && oldOwner.revoked && newOwner != nil && newOwner != oldOwner && !newOwner.revoked && newOwner.matches(persistedAccountSession{Token: newSession.Token, ExpiresAt: newSession.ExpiresAt})
	f.host.bootstrapMu.Unlock()
	if !current {
		t.Fatal("new recovery projection reset old revocation or reused its owner")
	}
}

func TestDirectoryAndRecoveryAuthorityRejectChangedScopeAtEveryRead(t *testing.T) {
	for _, operation := range []string{"directory", "recovery"} {
		for _, stage := range []string{"first", "members", "last"} {
			for _, change := range []string{"session-replaced", "cancelled", "service-removed", "host-close"} {
				t.Run(operation+"/"+stage+"/"+change, func(t *testing.T) {
					f, session, b, recorder := consumerAuthorityFixture(t, "/no-gate")
					paths := map[string]string{"first": "/v1/networks", "members": "/v1/networks/" + f.networkID + "/devices", "last": "/v1/devices"}
					if operation == "recovery" {
						paths = map[string]string{"first": "/v1/user", "members": "/v1/networks", "last": "/v1/networks/" + f.networkID + "/devices"}
					}
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
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					done := make(chan consumerAuthorityResult, 1)
					go func() {
						method, data := "directory.refresh", json.RawMessage(`{}`)
						if operation == "recovery" {
							method = "device.certificate_recovery_scope"
							data, _ = json.Marshal(map[string]string{"deviceId": f.original.DeviceID, "token": session.Token})
						}
						payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
						value, err := f.host.Handle(ctx, method, payload)
						done <- consumerAuthorityResult{value, err}
					}()
					consumerAuthorityWait(t, "consumer TLS read", b.entered)
					changed := make(chan struct{})
					want := "p2p.user_scope_mismatch"
					switch change {
					case "session-replaced":
						replacement := session
						replacement.Token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
						if err := f.host.saveAccountSession(f.account.identity.ServiceID, replacement); err != nil {
							t.Fatal(err)
						}
						close(changed)
					case "cancelled":
						want = "p2p.request_cancelled"
						cancel()
						close(changed)
					case "service-removed":
						want = "p2p.service_unconfigured"
						go func() { f.host.ForgetService(f.account.identity.ServiceID); close(changed) }()
						deadline := time.Now().Add(3 * time.Second)
						for {
							f.host.mu.Lock()
							removed := f.host.accounts[f.account.identity.ServiceID] == nil
							f.host.mu.Unlock()
							if removed {
								break
							}
							if !time.Now().Before(deadline) {
								t.Fatal("actual ForgetService did not publish its removal fence")
							}
							runtime.Gosched()
						}
					case "host-close":
						want = "p2p.request_cancelled"
						go func() { f.host.Close(); close(changed) }()
						consumerAuthorityWait(t, "actual Host.Close cancellation", f.host.ctx.Done())
					}
					b.once.Do(func() { close(b.release) })
					result := consumerAuthorityReceive(t, done)
					consumerAuthorityWait(t, "scope-change cleanup", changed)
					certificateError(t, result.err, want)
					if operation == "recovery" && result.value != nil || f.account.snapshot(f.account.identity.ServiceID).Known || len(recorder.announcements()) != 0 {
						t.Fatal("stale/cancelled consumer published selected authority")
					}
				})
			}
		}
	}
}
