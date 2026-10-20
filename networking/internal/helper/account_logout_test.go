package helper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// Real production TLS/Host/Manager admission with a test-only protocol oracle.
// A separately scoped peersession test proves that this same logout fence closes
// a real local gateway; this composition does not claim real remote DSH traffic.
func activeLogoutFixture(t *testing.T) (*certificateFixture, controlplane.UserSession, string) {
	t.Helper()
	f, stored := bootstrapFixture(t)
	session := controlplane.UserSession{User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}, Token: stored.Token, ExpiresAt: stored.ExpiresAt}
	f.mu.Lock()
	f.loginSession, f.grantSessionToken = &session, session.Token
	f.mu.Unlock()
	if count := f.host.RestoreOwnCredentials(context.Background()); count != 1 || !f.account.manager.CandidatesActive() {
		t.Fatal("logout fixture did not complete fresh scoped candidate activation", count)
	}
	pairID := f.scopedIdentity.Target.DeviceID
	_, err := f.account.manager.Connect(context.Background(), pairID, f.host.nextGeneration(), true)
	certificateError(t, err, "p2p.peer_offline")
	if !f.account.manager.WorkbenchRequested(pairID) || f.account.client.Account() != session.User.UserID {
		t.Fatal("logout fixture did not admit the previous selected-B workbench intent")
	}
	return f, session, pairID
}

type logoutFailureStore struct {
	*memoryStore
	mu           sync.Mutex
	sessionKey   string
	deleteFails  bool
	readbackFail bool
	deleted      bool
}

func (store *logoutFailureStore) Get(key string) ([]byte, error) {
	store.mu.Lock()
	failed := key == store.sessionKey && store.readbackFail && store.deleted
	store.mu.Unlock()
	if failed {
		return nil, secret.ErrRead
	}
	return store.memoryStore.Get(key)
}

func (store *logoutFailureStore) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if key == store.sessionKey && store.deleteFails {
		return secret.ErrDelete
	}
	if err := store.memoryStore.Delete(key); err != nil {
		return err
	}
	if key == store.sessionKey {
		store.deleted = true
	}
	return nil
}

func TestAccountLogoutRealTLSFailurePriorityAndLocalRetirement(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		requests   int
		revoked    bool
		deleteFail bool
	}{
		{"selection-missing-record", "p2p.invalid_device_state", 0, false, false},
		{"selection-missing-client", "p2p.invalid_device_state", 0, false, false},
		{"http401", "p2p.user_unauthorized", 1, false, false},
		{"http429", "p2p.rate_limited", 1, false, false},
		{"post-record-changed", "p2p.identity_mismatch", 1, true, false},
		{"delete-failed", "p2p.secret_delete_failed", 1, true, true},
		{"readback-failed", "p2p.secret_read_failed", 1, true, false},
		{"http429-delete-failed", "p2p.rate_limited", 1, false, true},
		{"post-record-changed-delete-failed", "p2p.identity_mismatch", 1, true, true},
		{"manager-closed", "p2p.helper_unavailable", 1, true, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, session, pairID := activeLogoutFixture(t)
			manager, client := f.account.manager, f.account.client
			t.Cleanup(client.Close)
			store := &logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: scenario.deleteFail, readbackFail: scenario.name == "readback-failed"}
			f.host.SetDeviceKeys(store)
			f.mu.Lock()
			beforeAuth, beforeHello := len(f.authRequests), len(f.hellos)
			switch scenario.name {
			case "http401":
				f.authReplyCode = "p2p.user_unauthorized"
			case "http429", "http429-delete-failed":
				f.authReplyCode = "p2p.rate_limited"
			case "post-record-changed", "post-record-changed-delete-failed":
				f.authReplyGate = func(r *http.Request) {
					if r.URL.Path == "/v1/logout" {
						changed := f.original
						changed.DeviceID = protocol.NewID()
						if err := f.host.SaveCredential(f.account.identity.ServiceID, changed, f.private); err != nil {
							t.Error(err)
						}
					}
				}
			}
			f.mu.Unlock()
			switch scenario.name {
			case "selection-missing-record":
				if err := f.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
			case "selection-missing-client":
				f.account.client = nil
			case "manager-closed":
				manager.Close()
			}
			_, err := f.host.Handle(context.Background(), "user.logout", logoutPayload(f, session.Token))
			certificateError(t, err, scenario.code)
			if client.Account() != "" || manager.CandidatesActive() || manager.WorkbenchRequested(pairID) || len(f.account.authRecoveryJoins) != 0 || f.account.activationPending != nil || f.account.activationSource != nil {
				t.Fatal("failed logout kept previous local rights or invented recovery provenance")
			}
			if scenario.deleteFail && !errors.Is(err, secret.ErrDelete) {
				t.Fatal("primary auth/post refusal discarded the concrete durable deletion failure")
			}
			_, existsErr := f.store.Get(accountSessionPrefix + f.account.identity.ServiceID)
			if scenario.deleteFail && existsErr != nil || !scenario.deleteFail && !errors.Is(existsErr, secret.ErrMissing) {
				t.Fatal("durable deletion result did not match its actual provider operation", existsErr)
			}
			f.mu.Lock()
			requests, hellos, revoked := len(f.authRequests)-beforeAuth, len(f.hellos), f.logoutRevoked
			f.mu.Unlock()
			if requests != scenario.requests || hellos != beforeHello || revoked != scenario.revoked {
				t.Fatal("logout replayed a request, dialed WSS or changed the actual remote outcome", requests, hellos, revoked)
			}
		})
	}
}

func TestAccountLogoutRejectsUnownedInputAndProtectsReplacementSession(t *testing.T) {
	for _, scenario := range []string{"bad-payload", "unknown-service", "old-token", "replacement-in-flight"} {
		t.Run(scenario, func(t *testing.T) {
			f, session, pairID := activeLogoutFixture(t)
			replacement := persistedAccountSession{Token: strings.Repeat("b", 64), ExpiresAt: session.ExpiresAt}
			payload := logoutPayload(f, session.Token)
			want := "p2p.user_scope_mismatch"
			f.mu.Lock()
			beforeAuth, beforeHello := len(f.authRequests), len(f.hellos)
			if scenario == "replacement-in-flight" {
				f.authReplyGate = func(r *http.Request) {
					if r.URL.Path == "/v1/logout" {
						if err := f.host.saveAccountSession(f.account.identity.ServiceID, replacement); err != nil {
							t.Error(err)
						}
						f.account.rememberToken(replacement.Token)
					}
				}
			}
			f.mu.Unlock()
			switch scenario {
			case "bad-payload":
				data := json.RawMessage(`{"token":"` + session.Token + `","extra":true}`)
				payload, _ = json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
				want = "p2p.invalid_request"
			case "unknown-service":
				data, _ := json.Marshal(map[string]string{"token": session.Token})
				payload, _ = json.Marshal(scopedRequest{ServiceID: protocol.NewID(), Data: data})
				want = "p2p.service_unconfigured"
			case "old-token":
				if err := f.host.saveAccountSession(f.account.identity.ServiceID, replacement); err != nil {
					t.Fatal(err)
				}
				f.account.rememberToken(replacement.Token)
			}
			_, err := f.host.Handle(context.Background(), "user.logout", payload)
			certificateError(t, err, want)
			if f.account.client.Account() != session.User.UserID || !f.account.manager.CandidatesActive() || !f.account.manager.WorkbenchRequested(pairID) || len(f.account.authRecoveryJoins) != 0 {
				t.Fatal("unowned or late logout cleared a different current local owner")
			}
			stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
			if err != nil || !exists || (scenario == "old-token" || scenario == "replacement-in-flight") && stored != replacement || scenario != "old-token" && scenario != "replacement-in-flight" && stored.Token != session.Token {
				t.Fatal("late/unowned logout erased a different durable session", err)
			}
			f.mu.Lock()
			requests, hellos := len(f.authRequests)-beforeAuth, len(f.hellos)
			f.mu.Unlock()
			wantRequests := 0
			if scenario == "replacement-in-flight" {
				wantRequests = 1
			}
			if requests != wantRequests || hellos != beforeHello {
				t.Fatal("rejected/late logout sent an unauthorized replay or dialed")
			}
		})
	}
}

func logoutPayload(f *certificateFixture, token string) json.RawMessage {
	data, _ := json.Marshal(map[string]string{"token": token})
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
	return payload
}

func TestAccountLogoutRealTLSInterruptedResponseStillFencesCapturedOwner(t *testing.T) {
	for _, scenario := range []string{"caller-cancel", "record-removed", "session-removed", "host-close"} {
		t.Run(scenario, func(t *testing.T) {
			f, session, pairID := activeLogoutFixture(t)
			manager, client := f.account.manager, f.account.client
			entered, release := make(chan struct{}), make(chan struct{})
			abort := make(chan struct{})
			t.Cleanup(func() { close(abort) })
			f.mu.Lock()
			beforeAuth, beforeHello := len(f.authRequests), len(f.hellos)
			f.authReplyGate = func(r *http.Request) {
				if r.URL.Path != "/v1/logout" {
					return
				}
				body, err := io.ReadAll(io.LimitReader(r.Body, 3))
				if err != nil || string(body) != "{}" {
					t.Error("real logout changed its exact empty-body contract", err)
				}
				close(entered)
				if scenario == "caller-cancel" || scenario == "host-close" {
					select {
					case <-r.Context().Done():
					case <-abort:
					}
					return
				}
				select {
				case <-release:
				case <-r.Context().Done():
				}
			}
			f.mu.Unlock()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			closed := make(chan struct{})
			returned := make(chan error, 1)
			go func() {
				_, err := f.host.Handle(ctx, "user.logout", logoutPayload(f, session.Token))
				returned <- err
			}()
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("real logout did not reach the exact TLS route")
			}
			if scenario == "caller-cancel" {
				cancel()
			} else if scenario == "host-close" {
				go func() { f.host.Close(); close(closed) }()
			} else if scenario == "session-removed" {
				if err := f.host.deleteAccountSession(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
			} else if err := f.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
				t.Fatal(err)
			}
			close(release)
			var err error
			select {
			case err = <-returned:
			case <-time.After(2 * time.Second):
				t.Fatal("interrupted logout lost its operation-owned cleanup/join")
			}
			if scenario == "host-close" {
				select {
				case <-closed:
				case <-time.After(2 * time.Second):
					t.Fatal("Host.Close and admitted logout lost their shared local teardown")
				}
			}
			if client.Account() != "" || manager.CandidatesActive() || manager.WorkbenchRequested(pairID) || len(f.account.authRecoveryJoins) != 0 {
				t.Fatal("interrupted logout erased durable authority but retained the old live selected-B owner")
			}
			want := "p2p.invalid_device_state"
			if scenario == "caller-cancel" || scenario == "host-close" {
				want = "p2p.server_unavailable"
			} else if scenario == "session-removed" {
				want = "p2p.user_scope_mismatch"
			}
			certificateError(t, err, want)
			if _, exists, readErr := f.host.readAccountSession(f.account.identity.ServiceID); readErr != nil || exists || f.account.activationPending != nil || f.account.activationSource != nil {
				t.Fatal("interrupted logout retained the old durable session or invented recovery provenance", readErr)
			}
			if _, readErr := manager.CurrentRegistration(session.User.UserID); readErr == nil {
				t.Fatal("interrupted logout retained its previous usable registration")
			}
			f.mu.Lock()
			requests := append([]accountTransportRequest{}, f.authRequests[beforeAuth:]...)
			hellos, revoked := len(f.hellos), f.logoutRevoked
			f.mu.Unlock()
			wantRevoked := scenario == "record-removed" || scenario == "session-removed"
			if len(requests) != 1 || requests[0].path != "/v1/logout" || !requests[0].verified || requests[0].deviceID != f.original.DeviceID || !requests[0].bearer || hellos != beforeHello || revoked != wantRevoked {
				t.Fatal("logout replayed HTTP, dialed WSS, changed TLS/Bearer identity or fabricated the remote outcome")
			}
		})
	}
}

func TestAccountLogoutNoManagerAndTLSFailureAreExplicit(t *testing.T) {
	for _, scenario := range []string{"device-without-manager", "setup", "device-TLS-failure"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAccountTransportTLS(t, scenario == "device-TLS-failure")
			client := f.account.client
			if scenario == "setup" {
				client.Close()
				f.account.client, f.account.httpPhase = nil, accountHTTPSetup
			}
			data, _ := json.Marshal(map[string]string{"token": f.token})
			payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
			_, err := f.account.host.Handle(context.Background(), "user.logout", payload)
			if scenario == "device-TLS-failure" {
				certificateError(t, err, "p2p.server_unavailable")
			} else if err != nil {
				t.Fatal("no-Manager logout did not acknowledge its actual successful HTTP revocation", err)
			}
			if scenario != "setup" && client.Account() != "" || f.account.manager != nil || f.account.activationPending != nil || f.account.activationSource != nil || len(f.account.authRecoveryJoins) != 0 {
				t.Fatal("explicit no-Manager logout retained selected authority or invented a registration")
			}
			if _, exists, err := f.account.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
				t.Fatal("no-Manager logout retained its durable authority", err)
			}
			requests := f.snapshot()
			if scenario == "device-TLS-failure" {
				if len(requests) != 0 {
					t.Fatal("failed device TLS replayed public revocation")
				}
			} else if len(requests) != 1 || requests[0].path != "/v1/logout" || !requests[0].bearer || requests[0].verified != (scenario != "setup") {
				t.Fatal("no-Manager request did not keep its explicit setup/device identity")
			}
		})
	}
}

func TestAccountLogoutAlreadyClosedHostDoesNotClaimAnUnadmittedRevocation(t *testing.T) {
	f, session, pairID := activeLogoutFixture(t)
	manager := f.account.manager
	f.mu.Lock()
	before := len(f.authRequests)
	f.mu.Unlock()
	f.host.Close()
	_, err := f.host.Handle(context.Background(), "user.logout", logoutPayload(f, session.Token))
	certificateError(t, err, "p2p.helper_unavailable")
	if manager.CandidatesActive() || manager.WorkbenchRequested(pairID) {
		t.Fatal("already closed Host retained live local authority")
	}
	if stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || !exists || stored.Token != session.Token {
		t.Fatal("an unadmitted closed-Host request falsely performed durable logout", err)
	}
	f.mu.Lock()
	requests, revoked := len(f.authRequests)-before, f.logoutRevoked
	f.mu.Unlock()
	if requests != 0 || revoked {
		t.Fatal("closed Host claimed or sent a remote revocation")
	}
}

func TestAccountLogoutUnownedInputCannotCancelFreshBootstrap(t *testing.T) {
	for _, scenario := range []string{"bad-payload", "wrong-token"} {
		t.Run(scenario, func(t *testing.T) {
			f, session := bootstrapFixture(t)
			f.rejectSignalAttempt = 2
			if count := f.host.RestoreOwnCredentials(context.Background()); count != 0 {
				t.Fatal("failed candidate activation claimed restored")
			}
			job := onlyBootstrap(t, f)
			entered, release := make(chan struct{}, 1), make(chan struct{})
			t.Cleanup(func() { close(release) })
			f.mu.Lock()
			f.identityEntered, f.identityRelease = entered, release
			f.mu.Unlock()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("fresh bootstrap did not reach its exact identity read")
			}
			payload := logoutPayload(f, strings.Repeat("b", 64))
			want := "p2p.user_scope_mismatch"
			if scenario == "bad-payload" {
				data := json.RawMessage(`{"token":"` + session.Token + `","extra":true}`)
				payload, _ = json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: data})
				want = "p2p.invalid_request"
			}
			_, err := f.host.Handle(context.Background(), "user.logout", payload)
			certificateError(t, err, want)
			if job.ctx.Err() != nil {
				t.Fatal("unowned logout cancelled a different current activation owner before token admission")
			}
			select {
			case <-job.done:
				t.Fatal("unowned logout joined/retired a still-current fresh-pin owner")
			default:
			}
		})
	}
}

func TestAccountLogoutCapturedAdmissionCannotCancelReplacementBootstrap(t *testing.T) {
	for _, scenario := range []string{"replacement-session", "new-generation"} {
		t.Run(scenario, func(t *testing.T) {
			f, original := bootstrapFixture(t)
			data, _ := json.Marshal(map[string]string{"token": original.Token})
			admission, err := f.host.admitLogoutBootstrap(f.account.identity.ServiceID, data)
			if err != nil {
				t.Fatal(err)
			}
			replacement := original
			replacement.Token = strings.Repeat("b", 64)
			if err := f.host.saveAccountSession(f.account.identity.ServiceID, replacement); err != nil {
				t.Fatal(err)
			}
			if scenario == "new-generation" {
				// The ordinary explicit auth owner advances its existing generation.
				// Logout must not advance/cancel that newer owner again.
				f.host.cancelBootstraps(f.account.identity.ServiceID)
			}
			entered, release := make(chan struct{}, 1), make(chan struct{})
			t.Cleanup(func() { close(release) })
			f.mu.Lock()
			f.identityEntered, f.identityRelease = entered, release
			f.mu.Unlock()
			job, err := f.host.captureBootstrap(f.account.identity.ServiceID)
			if err != nil {
				t.Fatal(err)
			}
			f.host.scheduleCapturedBootstrap(job)
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("replacement owner did not reach its real fresh identity request")
			}
			f.host.bootstrapMu.Lock()
			before := f.host.bootstrapGeneration[f.account.identity.ServiceID]
			f.host.bootstrapMu.Unlock()
			certificateError(t, f.host.cancelLogoutBootstrap(admission), "p2p.user_scope_mismatch")
			f.host.bootstrapMu.Lock()
			preserved := f.host.bootstraps[f.account.identity.ServiceID] == job && !job.sessionOwner.revoked && f.host.bootstrapGeneration[f.account.identity.ServiceID] == before
			f.host.bootstrapMu.Unlock()
			if !preserved || job.ctx.Err() != nil {
				t.Fatal("captured old logout cancelled, revoked or advanced a new session/generation owner")
			}
		})
	}
}

func TestAccountLogoutDeleteFailureRejectsCapturedAndFreshBootstrap(t *testing.T) {
	f, session, pairID := activeLogoutFixture(t)
	job, err := f.host.captureBootstrap(f.account.identity.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	store := &logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true}
	f.host.SetDeviceKeys(store)
	f.mu.Lock()
	beforeHello, beforeService := len(f.hellos), f.serviceQueries
	f.mu.Unlock()
	f.host.bootstrapMu.Lock()
	beforeGeneration := f.host.bootstrapGeneration[f.account.identity.ServiceID]
	f.host.bootstrapMu.Unlock()
	_, err = f.host.Handle(context.Background(), "user.logout", logoutPayload(f, session.Token))
	certificateError(t, err, "p2p.secret_delete_failed")
	// The provider still really retains the old token; neither old captured work
	// nor automatic fresh capture may reinterpret deletion failure as permission.
	if stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || !exists || stored.Token != session.Token {
		t.Fatal("delete-failure fixture did not retain its actual durable record", err)
	}
	f.host.scheduleCapturedBootstrap(job)
	if job.ctx != nil {
		t.Fatal("captured old bootstrap scheduled after its exact logout owner was revoked")
	}
	for _, value := range job.credential.PrivateKey {
		if value != 0 {
			t.Fatal("rejected captured bootstrap retained its private key")
		}
	}
	if count := f.host.RestoreOwnCredentials(context.Background()); count != 0 || f.account.client.Account() != "" || f.account.manager.CandidatesActive() || f.account.manager.WorkbenchRequested(pairID) {
		t.Fatal("durable delete failure resurrected the old selected account", count)
	}
	f.host.bootstrapMu.Lock()
	mutated := f.host.bootstrapGeneration[f.account.identity.ServiceID] != beforeGeneration || f.host.bootstraps[f.account.identity.ServiceID] != nil
	f.host.bootstrapMu.Unlock()
	f.mu.Lock()
	dialed := len(f.hellos) != beforeHello || f.serviceQueries != beforeService
	f.mu.Unlock()
	if mutated || dialed {
		t.Fatal("local logout changed a global generation or revived network/bootstrap work")
	}
}
