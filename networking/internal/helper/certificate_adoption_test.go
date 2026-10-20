package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Only these registered routes are observed. This bounded test-only ledger
// deliberately has no URL, headers, body, token, key or device/account ID fields.
type canonicalRequest struct {
	Method    string `json:"method"`
	Route     string `json:"registeredRoute"`
	Status    int    `json:"status"`
	Principal string `json:"principalSlot"`
}

type canonicalLedger struct {
	mu        sync.Mutex
	records   []canonicalRequest
	dropped   int
	intercept func(http.ResponseWriter, *http.Request) bool
}

type canonicalStatus struct {
	http.ResponseWriter
	status int
}

func (w *canonicalStatus) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *canonicalStatus) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (ledger *canonicalLedger) observe(w http.ResponseWriter, r *http.Request, serve http.HandlerFunc) {
	route := r.URL.Path
	switch route {
	case "/v1/user", "/v1/certificate-query", "/v1/renew-certificate", "/v1/recover-certificate":
	default:
		serve(w, r)
		return
	}
	principal := "public"
	if len(r.TLS.PeerCertificates) != 0 && len(r.TLS.VerifiedChains) != 0 {
		principal = "original-device"
	}
	status := &canonicalStatus{ResponseWriter: w}
	if ledger.intercept == nil || !ledger.intercept(status, r) {
		serve(status, r)
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if len(ledger.records) == 64 {
		ledger.dropped++
		return
	}
	ledger.records = append(ledger.records, canonicalRequest{r.Method, route, status.status, principal})
}

func (ledger *canonicalLedger) count(t *testing.T, route, principal string) int {
	t.Helper()
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if ledger.dropped != 0 {
		t.Fatal("bounded request ledger overflowed; counts are incomplete")
	}
	count := 0
	for _, request := range ledger.records {
		if request.Route == route && request.Principal == principal {
			count++
		}
	}
	return count
}

func (ledger *canonicalLedger) report(t *testing.T) {
	t.Helper()
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	body, err := json.Marshal(struct {
		Records []canonicalRequest `json:"records"`
		Dropped int                `json:"dropped"`
	}{ledger.records, ledger.dropped})
	if err != nil {
		t.Fatal("request ledger encoding failed")
	}
	t.Logf("canonical-adoption-request-ledger %s", body)
}

func canonicalFixture(t *testing.T, remaining time.Duration) (*certificateFixture, *canonicalLedger) {
	t.Helper()
	f := newCertificateFixture(t, remaining)
	f.selectedUserID = protocol.NewID()
	for f.selectedUserID == f.original.UserID {
		f.selectedUserID = protocol.NewID()
	}
	f.scopedIdentity = nil // A complete, truly empty discovery needs no remote.
	session := persistedAccountSession{Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, session); err != nil {
		t.Fatal(err)
	}
	if err := f.host.SaveCredential(f.account.identity.ServiceID, f.original, f.private); err != nil {
		t.Fatal(err)
	}
	ledger := &canonicalLedger{}
	f.setHTTPObserver(ledger.observe)
	t.Cleanup(func() { ledger.report(t) })
	return f, ledger
}

func canonicalOwnRestore(t *testing.T, f *certificateFixture, ctx context.Context) error {
	t.Helper()
	origin, err := f.host.captureBootstrap(f.account.identity.ServiceID)
	if err != nil {
		return err
	}
	defer clear(origin.credential.PrivateKey)
	origin.ctx = ctx
	guarded := context.WithValue(ctx, bootstrapGuardKey{}, func() error { return f.host.checkBootstrapSource(origin, false) })
	return f.host.restoreStoredCredential(guarded, origin.credential)
}

func TestCanonicalRestoreAdoptionOneQueryKeepsBothFreshUsersAndOwner(t *testing.T) {
	f, ledger := canonicalFixture(t, 30*24*time.Hour)
	if err := canonicalOwnRestore(t, f, context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := ledger.count(t, "/v1/certificate-query", "public"); got != 1 {
		t.Fatalf("one restore performed %d canonical queries, want exactly one", got)
	}
	if got := ledger.count(t, "/v1/user", "public"); got != 2 {
		t.Fatalf("restore lost its two independent fresh selected-account confirmations: got %d", got)
	}
	if got := ledger.count(t, "/v1/user", "original-device"); got != 1 {
		t.Fatalf("fresh catalog authorization count = %d, want one", got)
	}
	stored, err := f.host.LoadCredential(f.account.identity.ServiceID)
	if err != nil || stored.UserID != f.original.UserID || !bytes.Equal(stored.Certificate, f.original.Certificate) ||
		f.account.client.Account() != f.selectedUserID || f.account.device.UserID != f.original.UserID || !f.account.manager.CandidatesActive() {
		t.Fatal("canonical owner A replaced selected B or original certificate/activation changed")
	}
	// Independent certificate operations must each perform their own fresh query.
	for range 2 {
		if _, err := f.call(f.original, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if got := ledger.count(t, "/v1/certificate-query", "public"); got != 3 {
		t.Fatalf("standalone operations reused completed canonical proof: count %d, want three", got)
	}
}

func TestCanonicalRestoreAdoptionIssuanceRetainsIndependentReadback(t *testing.T) {
	for _, kind := range []string{"renew-success", "canonical-refused", "issuance-refused", "readback-refused"} {
		t.Run(kind, func(t *testing.T) {
			f, ledger := canonicalFixture(t, time.Hour)
			want, queries, renewals := "", 2, 1
			switch kind {
			case "canonical-refused":
				f.queryCode, want, queries, renewals = "p2p.identity_mismatch", "p2p.identity_mismatch", 1, 0
			case "issuance-refused":
				want, queries = "p2p.identity_mismatch", 1
				ledger.intercept = func(w http.ResponseWriter, r *http.Request) bool {
					if r.URL.Path != "/v1/renew-certificate" {
						return false
					}
					f.refuse(w, "p2p.identity_mismatch")
					return true
				}
			case "readback-refused":
				want = "p2p.identity_mismatch"
				f.afterIssue = func() { f.queryCode = "p2p.identity_mismatch" }
			}
			err := canonicalOwnRestore(t, f, context.Background())
			if want == "" && err != nil || want != "" && (err == nil || err.Error() != want) {
				t.Fatalf("issuance outcome = %v, want exact code %q", err, want)
			}
			if ledger.count(t, "/v1/certificate-query", "public") != queries || ledger.count(t, "/v1/renew-certificate", "original-device") != renewals {
				t.Fatal("initial proof and independent post-issuance readback counts changed")
			}
			if want != "" && (f.account.client != nil || f.account.manager != nil) {
				t.Fatal("failed proof or issuance published device authority")
			}
		})
	}
}

func TestCanonicalRestoreAdoptionLateProofCannotPublish(t *testing.T) {
	for _, kind := range []string{"record-replaced", "record-missing", "record-authority-replaced", "account-replaced", "session-replaced", "generation-replaced", "caller-cancelled", "host-closed"} {
		t.Run(kind, func(t *testing.T) {
			f, ledger := canonicalFixture(t, 30*24*time.Hour)
			f.queryEntered, f.queryRelease = make(chan struct{}, 1), make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- canonicalOwnRestore(t, f, ctx) }()
			select {
			case <-f.queryEntered:
			case <-time.After(3 * time.Second):
				t.Fatal("canonical proof did not enter real TLS handler")
			}
			want := "p2p.user_scope_mismatch"
			var closed chan struct{}
			switch kind {
			case "record-replaced":
				changed := f.original
				changed.Name = "foreign replacement"
				if err := f.host.SaveCredential(f.account.identity.ServiceID, changed, f.private); err != nil {
					t.Fatal(err)
				}
				want = "p2p.identity_mismatch"
			case "record-missing":
				if err := f.store.Delete(credentialKey(f.account.identity.ServiceID)); err != nil {
					t.Fatal(err)
				}
				want = "p2p.secret_missing"
			case "record-authority-replaced":
				record, err := f.host.LoadCredential(f.account.identity.ServiceID)
				if err != nil {
					t.Fatal(err)
				}
				record.Endpoints.STUNAddress = "127.0.0.1:3479"
				body, err := json.Marshal(record)
				if err != nil {
					t.Fatal("record encoding failed")
				}
				if err := f.store.Set(credentialKey(record.ServiceID), body); err != nil {
					t.Fatal(err)
				}
				clear(record.PrivateKey)
				clear(body)
				want = "p2p.identity_mismatch"
			case "account-replaced":
				f.host.mu.Lock()
				f.host.accounts[f.account.identity.ServiceID] = &account{host: f.host, identity: f.account.identity, endpoints: f.account.endpoints, httpPhase: accountHTTPSetup}
				f.host.mu.Unlock()
				// The old account remains test-owned even after its service slot changes.
				defer func() {
					f.host.mu.Lock()
					f.host.accounts[f.account.identity.ServiceID] = f.account
					f.host.mu.Unlock()
				}()
				want = "p2p.service_unconfigured"
			case "session-replaced":
				if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: strings.Repeat("b", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
					t.Fatal(err)
				}
			case "generation-replaced":
				f.host.cancelBootstraps(f.account.identity.ServiceID)
			case "caller-cancelled":
				cancel()
				want = "p2p.request_cancelled"
			case "host-closed":
				closed = make(chan struct{})
				go func() { f.host.Close(); close(closed) }()
				<-f.host.ctx.Done()
				want = "p2p.request_cancelled"
			}
			close(f.queryRelease)
			select {
			case err := <-done:
				certificateError(t, err, want)
			case <-time.After(3 * time.Second):
				t.Fatal("late-proof owner did not return/join")
			}
			if closed != nil {
				select {
				case <-closed:
				case <-time.After(3 * time.Second):
					t.Fatal("Host close did not join")
				}
			}
			f.account.mu.Lock()
			published := f.account.client != nil || f.account.manager != nil
			f.account.mu.Unlock()
			if published || ledger.count(t, "/v1/renew-certificate", "original-device") != 0 {
				t.Fatal("superseded proof published authority or issued a certificate")
			}
		})
	}
}

func TestCanonicalRestoreAdoptionSecondFreshUserCannotBeSkipped(t *testing.T) {
	f, ledger := canonicalFixture(t, 30*24*time.Hour)
	var users atomic.Int32
	ledger.intercept = func(_ http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/v1/user" {
			if users.Add(1) == 2 {
				f.mu.Lock()
				f.selectedUserID = protocol.NewID()
				f.mu.Unlock()
			}
		}
		return false
	}
	certificateError(t, canonicalOwnRestore(t, f, context.Background()), "p2p.user_scope_mismatch")
	if users.Load() != 2 || ledger.count(t, "/v1/certificate-query", "public") != 0 || f.account.manager != nil || f.account.client != nil {
		t.Fatal("second fresh user change reached canonical adoption or Manager publication")
	}
}

func TestCanonicalRestoreAdoptionRecordComparisonAndWriteShareCredentialLock(t *testing.T) {
	f, ledger := canonicalFixture(t, time.Hour)
	origin, err := f.host.captureBootstrap(f.account.identity.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(origin.credential.PrivateKey)
	origin.ctx = context.Background()
	var lockedChecks atomic.Int32
	ctx := context.WithValue(context.Background(), bootstrapGuardKey{}, func() error {
		// There is no independent credential writer in this test. Failed TryLock
		// therefore proves this very owner checked its expected record while
		// holding the same mutex used by every SaveCredential writer.
		if f.host.credentialMu.TryLock() {
			f.host.credentialMu.Unlock()
		} else {
			lockedChecks.Add(1)
		}
		return f.host.checkBootstrapSource(origin, false)
	})
	if err := f.host.restoreStoredCredential(ctx, origin.credential); err != nil {
		t.Fatal(err)
	}
	if lockedChecks.Load() < 2 || ledger.count(t, "/v1/certificate-query", "public") != 2 {
		t.Fatal("canonical check/write/readback did not retain the credential lock or issuance readback")
	}
}

func TestCanonicalRestoreAdoptionLateRegistrationClosesAndJoinsBothEntryPoints(t *testing.T) {
	for _, entry := range []string{"Handle", "headless"} {
		t.Run(entry, func(t *testing.T) {
			f, _ := canonicalFixture(t, 30*24*time.Hour)
			entered, release := make(chan struct{}), make(chan struct{})
			f.signalClosed = make(chan struct{})
			f.signalReadyGate = func() { close(entered); <-release }
			// Exercise the actual external callback owner before publication while
			// account.mu is held. It must not block; internal WSS is not disabled.
			publication := &restorePublication{host: f.host, account: f.account}
			f.account.mu.Lock()
			emitted := make(chan struct{})
			go func() { publication.emit(peersession.State{}); close(emitted) }()
			select {
			case <-emitted:
			case <-time.After(time.Second):
				f.account.mu.Unlock()
				t.Fatal("unpublished external emit waited for account.mu")
			}
			f.account.mu.Unlock()
			done := make(chan error, 1)
			go func() {
				if entry == "headless" {
					done <- canonicalOwnRestore(t, f, context.Background())
					return
				}
				payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []any{}, "accountUserId": f.selectedUserID}})
				_, err := f.host.Handle(context.Background(), "device.restore", payload)
				done <- err
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("fresh read-only WSS registration did not enter")
			}
			f.host.cancelBootstraps(f.account.identity.ServiceID)
			close(release)
			select {
			case err := <-done:
				certificateError(t, err, "p2p.user_scope_mismatch")
			case <-time.After(3 * time.Second):
				t.Fatal("late registration cleanup did not unlock and join")
			}
			select {
			case <-f.signalClosed:
			case <-time.After(time.Second):
				t.Fatal("rejected real WSS registration was not closed")
			}
			f.account.mu.Lock()
			published := f.account.client != nil || f.account.manager != nil || len(f.account.authRecoveryJoins) != 0
			f.account.mu.Unlock()
			if published {
				t.Fatal("failed fresh Manager was published or its exact completion was abandoned")
			}
		})
	}
}

func TestCanonicalRestoreAdoptionExplicitLogoutRevokesInflightRestore(t *testing.T) {
	f, ledger := canonicalFixture(t, 30*24*time.Hour)
	session, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists {
		t.Fatal("explicit session is missing")
	}
	f.grantSessionToken = session.Token
	f.loginSession = &controlplane.UserSession{Token: session.Token, ExpiresAt: session.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.queryEntered, f.queryRelease = make(chan struct{}, 1), make(chan struct{})
	restoreDone, logoutDone := make(chan error, 1), make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var release sync.Once
	defer release.Do(func() { close(f.queryRelease) })
	go func() {
		payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []any{}, "accountUserId": f.selectedUserID}})
		_, err := f.host.Handle(ctx, "device.restore", payload)
		restoreDone <- err
	}()
	select {
	case <-f.queryEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("restore did not enter its canonical TLS query")
	}
	// Read the exact current owner for observation only, after restore's explicit
	// generation admission. The only revocation below is real Handle(user.logout).
	observed, err := f.host.captureBootstrap(f.account.identity.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(observed.credential.PrivateKey)
	go func() {
		payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]string{"token": session.Token}})
		_, err := f.host.Handle(ctx, "user.logout", payload)
		logoutDone <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.host.bootstrapMu.Lock()
		revoked := observed.sessionOwner != nil && observed.sessionOwner.revoked
		f.host.bootstrapMu.Unlock()
		if revoked {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("real logout did not revoke its exact admitted owner")
		}
		runtime.Gosched()
	}
	release.Do(func() { close(f.queryRelease) })
	select {
	case err := <-restoreDone:
		if err == nil || err.Error() != "p2p.user_scope_mismatch" {
			t.Errorf("restore admitted after real logout revocation: got %v, want p2p.user_scope_mismatch", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revoked restore did not return")
	}
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("explicit logout did not complete after restore unlocked")
	}
	f.mu.Lock()
	subscriptions, revoked := f.subscriptions, f.logoutRevoked
	f.mu.Unlock()
	if subscriptions != 0 || !revoked || ledger.count(t, "/v1/certificate-query", "public") != 1 {
		t.Fatal("revoked restore published WSS or real selected logout was not acknowledged")
	}
}

func TestCanonicalRestoreAdoptionFirstExplicitRestoreNeedsNoBootstrapJob(t *testing.T) {
	f, ledger := canonicalFixture(t, 30*24*time.Hour)
	f.host.bootstrapMu.Lock()
	prior := len(f.host.bootstraps) != 0 || len(f.host.bootstrapSessionOwners) != 0
	f.host.bootstrapMu.Unlock()
	if prior {
		t.Fatal("first explicit restore test already had an ownership object")
	}
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []any{}, "accountUserId": f.selectedUserID}})
	if _, err := f.host.Handle(context.Background(), "device.restore", payload); err != nil {
		t.Fatal(err)
	}
	f.host.bootstrapMu.Lock()
	owner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	current := owner != nil && !owner.revoked && len(f.host.bootstraps) == 0
	f.host.bootstrapMu.Unlock()
	if !current || ledger.count(t, "/v1/certificate-query", "public") != 1 || ledger.count(t, "/v1/user", "public") != 1 || ledger.count(t, "/v1/user", "original-device") != 1 || !f.account.manager.CandidatesActive() || f.account.device.UserID != f.original.UserID || f.account.client.Account() != f.selectedUserID {
		t.Fatal("first explicit restore inferred a prerequisite job, lost fresh auth or substituted enrollment owner")
	}
}

func TestCanonicalRestoreAdoptionRevokedSessionCannotRestartUnderNewGeneration(t *testing.T) {
	f, ledger := canonicalFixture(t, 30*24*time.Hour)
	stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists {
		t.Fatal("original selected session is missing")
	}
	session := controlplane.UserSession{Token: stored.Token, ExpiresAt: stored.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.grantSessionToken, f.loginSession = session.Token, &session
	restorePayload := func() json.RawMessage {
		body, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []any{}, "accountUserId": f.selectedUserID}})
		return body
	}
	if _, err := f.host.Handle(context.Background(), "device.restore", restorePayload()); err != nil {
		t.Fatal(err)
	}
	store := &logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true}
	f.host.SetDeviceKeys(store)
	f.mu.Lock()
	f.authReplyCode = "p2p.rate_limited"
	f.mu.Unlock()
	_, err = f.host.Handle(context.Background(), "user.logout", logoutPayload(f, session.Token))
	certificateError(t, err, "p2p.rate_limited")
	f.host.bootstrapMu.Lock()
	oldOwner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	oldGeneration := f.host.bootstrapGeneration[f.account.identity.ServiceID]
	revoked := oldOwner != nil && oldOwner.revoked
	f.host.bootstrapMu.Unlock()
	if !revoked || f.account.client.Account() != "" || f.account.manager.CandidatesActive() {
		t.Fatal("failed logout retained old local rights")
	}
	if durable, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || !exists || durable != stored {
		t.Fatal("failed durable deletion did not preserve actual old session")
	}
	f.mu.Lock()
	beforeHello, beforeAuth := len(f.hellos), len(f.authRequests)
	remoteRevoked := f.logoutRevoked
	f.authReplyCode = "" // The real remote token remains valid after its HTTP refusal.
	f.mu.Unlock()
	if remoteRevoked {
		t.Fatal("refused remote logout was mislabeled acknowledged")
	}
	beforeQuery := ledger.count(t, "/v1/certificate-query", "public")
	_, err = f.host.Handle(context.Background(), "device.restore", restorePayload())
	if err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Errorf("same revoked session restarted under a new generation: %v", err)
	}
	f.host.bootstrapMu.Lock()
	preserved := f.host.bootstrapSessionOwners[f.account.identity.ServiceID] == oldOwner && oldOwner.revoked && f.host.bootstrapGeneration[f.account.identity.ServiceID] == oldGeneration
	f.host.bootstrapMu.Unlock()
	f.mu.Lock()
	unchangedRequests := len(f.hellos) == beforeHello && len(f.authRequests) == beforeAuth
	f.mu.Unlock()
	if !preserved || !unchangedRequests || ledger.count(t, "/v1/certificate-query", "public") != beforeQuery {
		t.Error("revoked-session admission mutated generation/owner or dispatched HTTP/WSS")
	}
	// New session authority must come from the real named login + fresh user
	// confirmation, not from raw replacement of the retained durable record.
	newSession := controlplane.UserSession{Token: strings.Repeat("b", 64), ExpiresAt: time.Now().Add(time.Hour).Unix(), User: controlplane.User{UserID: protocol.NewID(), Username: "selected@example.test"}}
	f.mu.Lock()
	f.selectedUserID, f.grantSessionToken, f.loginSession = newSession.User.UserID, newSession.Token, &newSession
	f.mu.Unlock()
	login, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]string{"username": "selected@example.test", "password": "new-isolated-test-password"}})
	result, err := f.host.Handle(context.Background(), "user.login", login)
	if err != nil || result.(controlplane.UserSession) != newSession {
		t.Fatal("genuine new login could not establish its fresh session", err)
	}
	if _, err := f.host.Handle(context.Background(), "device.restore", restorePayload()); err != nil {
		t.Fatal("new session restore was rejected by old revocation", err)
	}
	f.host.bootstrapMu.Lock()
	newOwner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	newCurrent := newOwner != nil && newOwner != oldOwner && !newOwner.revoked && oldOwner.revoked && newOwner.matches(persistedAccountSession{Token: newSession.Token, ExpiresAt: newSession.ExpiresAt})
	f.host.bootstrapMu.Unlock()
	if !newCurrent || f.account.client.Account() != newSession.User.UserID || !f.account.manager.CandidatesActive() || f.account.device.UserID != f.original.UserID {
		t.Fatal("old logout revoked a genuinely new selected session or enrollment identity")
	}
}

func TestCanonicalRestoreAdoptionRevokedSessionBlocksOtherReadmissionOwners(t *testing.T) {
	for _, entry := range []string{"user.current", "headless", "headless-after-failed-login"} {
		t.Run(entry, func(t *testing.T) {
			f, ledger := canonicalFixture(t, 30*24*time.Hour)
			stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
			if err != nil || !exists {
				t.Fatal("original selected session is missing")
			}
			session := controlplane.UserSession{Token: stored.Token, ExpiresAt: stored.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
			f.grantSessionToken, f.loginSession = session.Token, &session
			payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []any{}, "accountUserId": f.selectedUserID}})
			if _, err := f.host.Handle(context.Background(), "device.restore", payload); err != nil {
				t.Fatal(err)
			}
			f.host.SetDeviceKeys(&logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true})
			f.mu.Lock()
			f.authReplyCode = "p2p.rate_limited"
			f.mu.Unlock()
			_, err = f.host.Handle(context.Background(), "user.logout", logoutPayload(f, session.Token))
			certificateError(t, err, "p2p.rate_limited")
			f.host.bootstrapMu.Lock()
			oldOwner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
			f.host.bootstrapMu.Unlock()
			if oldOwner == nil || !oldOwner.revoked {
				t.Fatal("actual logout did not revoke old session owner")
			}
			if entry == "headless-after-failed-login" {
				login, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]string{"username": "selected@example.test", "password": "isolated-invalid-login"}})
				_, err = f.host.Handle(context.Background(), "user.login", login)
				certificateError(t, err, "p2p.rate_limited")
			}
			f.mu.Lock()
			f.authReplyCode = ""
			beforeAuth, beforeHello, beforeService := len(f.authRequests), len(f.hellos), f.serviceQueries
			f.mu.Unlock()
			beforeQuery := ledger.count(t, "/v1/certificate-query", "public")
			if entry == "user.current" {
				_, err := f.host.Handle(context.Background(), "user.current", logoutPayload(f, session.Token))
				if err == nil || err.Error() != "p2p.user_scope_mismatch" {
					t.Errorf("current-user revived revoked local session: %v", err)
				}
			}
			if restored := f.host.RestoreOwnCredentials(context.Background()); restored != 0 {
				t.Errorf("headless restored revoked session after %s: count %d", entry, restored)
			}
			f.host.bootstrapMu.Lock()
			owner, job := f.host.bootstrapSessionOwners[f.account.identity.ServiceID], f.host.bootstraps[f.account.identity.ServiceID]
			kept := owner == oldOwner && oldOwner.revoked && job == nil
			f.host.bootstrapMu.Unlock()
			f.mu.Lock()
			noReads := len(f.authRequests) == beforeAuth && len(f.hellos) == beforeHello && f.serviceQueries == beforeService
			f.mu.Unlock()
			if !kept || !noReads || ledger.count(t, "/v1/certificate-query", "public") != beforeQuery || f.account.client.Account() != "" || f.account.manager.CandidatesActive() {
				t.Error("readmission reset revoked session ownership, scheduled a job or re-authorized old scope")
			}
		})
	}
}

func TestCanonicalRestoreAdoptionLogoutWinsDuringCurrentUserHTTP(t *testing.T) {
	f, _ := canonicalFixture(t, 30*24*time.Hour)
	stored, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists {
		t.Fatal("original session is missing")
	}
	session := controlplane.UserSession{Token: stored.Token, ExpiresAt: stored.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.grantSessionToken, f.loginSession = session.Token, &session
	restore, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []any{}, "accountUserId": f.selectedUserID}})
	if _, err := f.host.Handle(context.Background(), "device.restore", restore); err != nil {
		t.Fatal(err)
	}
	f.host.SetDeviceKeys(&logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true})
	entered, release := make(chan struct{}), make(chan struct{})
	var gated, released sync.Once
	defer released.Do(func() { close(release) })
	f.mu.Lock()
	beforeAuth, beforeHello := len(f.authRequests), len(f.hellos)
	f.authReplyGate = func(r *http.Request) {
		if r.URL.Path == "/v1/user" {
			wait := false
			gated.Do(func() { wait = true; close(entered) })
			if wait {
				<-release
			}
		}
		if r.URL.Path == "/v1/logout" {
			f.mu.Lock()
			f.authReplyCode = "p2p.rate_limited"
			f.mu.Unlock()
		}
	}
	f.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	currentDone, logoutDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := f.host.Handle(ctx, "user.current", logoutPayload(f, session.Token))
		currentDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("current-user did not enter real TLS HTTP")
	}
	f.host.bootstrapMu.Lock()
	owner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	f.host.bootstrapMu.Unlock()
	go func() {
		_, err := f.host.Handle(ctx, "user.logout", logoutPayload(f, session.Token))
		logoutDone <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.host.bootstrapMu.Lock()
		revoked := owner != nil && owner.revoked
		f.host.bootstrapMu.Unlock()
		if revoked {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("actual logout did not revoke current-user's original session")
		}
		runtime.Gosched()
	}
	released.Do(func() { close(release) })
	select {
	case err := <-currentDone:
		certificateError(t, err, "p2p.user_scope_mismatch")
	case <-time.After(3 * time.Second):
		t.Fatal("late current-user did not settle")
	}
	select {
	case err := <-logoutDone:
		certificateError(t, err, "p2p.rate_limited")
	case <-time.After(3 * time.Second):
		t.Fatal("actual logout did not join after current-user unlocked")
	}
	f.mu.Lock()
	requests, hellos, remoteRevoked := len(f.authRequests)-beforeAuth, len(f.hellos), f.logoutRevoked
	f.mu.Unlock()
	if requests != 2 || hellos != beforeHello || remoteRevoked || f.account.client.Account() != "" || f.account.manager.CandidatesActive() || len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("late user response revived activation, added fresh catalog reads or abandoned logout cleanup")
	}
}

func TestCanonicalRestoreAdoptionLogoutWinsDuringCurrentCatalogRead(t *testing.T) {
	f, stored := bootstrapFixture(t)
	session := controlplane.UserSession{Token: stored.Token, ExpiresAt: stored.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.grantSessionToken, f.loginSession = session.Token, &session
	f.identityCode = "p2p.rate_limited"
	if restored := f.host.RestoreOwnCredentials(context.Background()); restored != 0 || f.account.manager == nil || f.account.manager.CandidatesActive() {
		t.Fatal("fixture did not retain a real readonly Manager")
	}
	entered, release := make(chan struct{}, 1), make(chan struct{})
	var released sync.Once
	defer released.Do(func() { close(release) })
	f.mu.Lock()
	f.identityCode = ""
	f.identityEntered, f.identityRelease = entered, release
	beforeHello := len(f.hellos)
	f.mu.Unlock()
	currentDone, logoutDone := make(chan error, 1), make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_, err := f.host.Handle(ctx, "user.current", logoutPayload(f, session.Token))
		currentDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("current-user did not reach its fresh TLS scoped-identity read")
	}
	f.host.bootstrapMu.Lock()
	owner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	f.host.bootstrapMu.Unlock()
	go func() {
		_, err := f.host.Handle(ctx, "user.logout", logoutPayload(f, session.Token))
		logoutDone <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.host.bootstrapMu.Lock()
		revoked := owner != nil && owner.revoked
		f.host.bootstrapMu.Unlock()
		if revoked {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("actual logout did not revoke catalog-read owner")
		}
		runtime.Gosched()
	}
	released.Do(func() { close(release) })
	select {
	case err := <-currentDone:
		if err == nil || err.Error() != "p2p.user_scope_mismatch" {
			t.Errorf("late current catalog read granted activation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("current catalog owner did not settle")
	}
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("actual logout did not join after catalog read")
	}
	f.mu.Lock()
	hellos := len(f.hellos)
	remoteRevoked := f.logoutRevoked
	f.mu.Unlock()
	if hellos != beforeHello || !remoteRevoked || f.account.manager.CandidatesActive() || f.account.client.Account() != "" || len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("revoked catalog result advertised a new candidate registration or abandoned exact logout cleanup")
	}
}

func TestCanonicalRestoreAdoptionLogoutWinsDuringCandidateActivationAwait(t *testing.T) {
	f, stored := bootstrapFixture(t)
	session := controlplane.UserSession{Token: stored.Token, ExpiresAt: stored.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.grantSessionToken, f.loginSession = session.Token, &session
	f.identityCode = "p2p.rate_limited"
	if f.host.RestoreOwnCredentials(context.Background()) != 0 || f.account.manager == nil || f.account.manager.CandidatesActive() {
		t.Fatal("fixture did not retain readonly registration")
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var released sync.Once
	defer released.Do(func() { close(release) })
	f.mu.Lock()
	f.identityCode = ""
	f.signalClosed = make(chan struct{})
	f.signalReadyGate = func() { close(entered); <-release }
	f.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	currentDone, logoutDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := f.host.Handle(ctx, "user.current", logoutPayload(f, session.Token))
		currentDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("current-user did not enter actual candidate registration await")
	}
	f.host.bootstrapMu.Lock()
	owner := f.host.bootstrapSessionOwners[f.account.identity.ServiceID]
	f.host.bootstrapMu.Unlock()
	go func() {
		_, err := f.host.Handle(ctx, "user.logout", logoutPayload(f, session.Token))
		logoutDone <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.host.bootstrapMu.Lock()
		revoked := owner != nil && owner.revoked
		f.host.bootstrapMu.Unlock()
		if revoked {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("logout did not revoke pending registration owner")
		}
		runtime.Gosched()
	}
	released.Do(func() { close(release) })
	select {
	case err := <-currentDone:
		certificateError(t, err, "p2p.user_scope_mismatch")
	case <-time.After(3 * time.Second):
		t.Fatal("activation await did not settle with its original scope refusal")
	}
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("queued exact logout did not finish its normal fence/join")
	}
	f.mu.Lock()
	hellos := append([]protocol.ControlHello(nil), f.hellos...)
	remoteRevoked := f.logoutRevoked
	f.mu.Unlock()
	// The candidate hello really was dispatched before revocation. Preserve that
	// remote effect, but never turn its late completion into local ready success.
	if len(hellos) != 2 || !protocol.HasCapability(hellos[1].Capabilities, protocol.CapabilityCandidate) || !remoteRevoked || f.account.manager.CandidatesActive() || f.account.client.Account() != "" || len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("late activation was published or exact logout cleanup was abandoned")
	}
	select {
	case <-f.signalClosed:
	case <-time.After(time.Second):
		t.Fatal("queued logout did not close the dispatched candidate WSS")
	}
}
