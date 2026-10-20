package helper

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func bootstrapFixture(t *testing.T) (*certificateFixture, persistedAccountSession) {
	t.Helper()
	f := newCertificateFixture(t, 30*24*time.Hour)
	f.selectedUserID = protocol.NewID()
	identity, _ := plantedPair(t, f.original.DeviceID, f.selectedUserID, f.original.PublicKey, "bootstrap remote", f.networkID)
	identity.Initiator.Presence, identity.Target.Presence = "online", "offline"
	f.scopedIdentity = &identity
	session := persistedAccountSession{Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, session); err != nil {
		t.Fatal(err)
	}
	if err := f.host.SaveCredential(f.account.identity.ServiceID, f.original, f.private); err != nil {
		t.Fatal(err)
	}
	return f, session
}

func onlyBootstrap(t *testing.T, f *certificateFixture) *bootstrapJob {
	t.Helper()
	f.host.bootstrapMu.Lock()
	defer f.host.bootstrapMu.Unlock()
	job := f.host.bootstraps[f.account.identity.ServiceID]
	if len(f.host.bootstraps) != 1 || job == nil {
		t.Fatal("transient failure did not retain one service owner")
	}
	return job
}

func TestBootstrapRetriesOriginalSessionBeforeManagerAndAfterReadOnlyFailure(t *testing.T) {
	for _, phase := range []string{"before-manager", "read-only"} {
		t.Run(phase, func(t *testing.T) {
			f, session := bootstrapFixture(t)
			if phase == "before-manager" {
				f.serviceCode = "p2p.server_unavailable"
			} else {
				f.identityCode = "p2p.rate_limited"
			}
			if restored := f.host.RestoreOwnCredentials(context.Background()); restored != 0 {
				t.Fatal("first transient failure claimed restored", restored)
			}
			job := onlyBootstrap(t, f)
			second, err := f.host.captureBootstrap(f.account.identity.ServiceID)
			if err != nil {
				t.Fatal(err)
			}
			f.host.scheduleCapturedBootstrap(second)
			if onlyBootstrap(t, f) != job {
				t.Fatal("overlapping bootstrap owner replaced the first")
			}
			f.mu.Lock()
			f.serviceCode, f.identityCode = "", ""
			f.mu.Unlock()
			select {
			case <-job.done:
			case <-time.After(3 * time.Second):
				t.Fatal("normal backoff did not finish original bootstrap")
			}
			if f.account.manager == nil || !f.account.manager.CandidatesActive() {
				t.Fatal("retry did not activate fresh candidate admission")
			}
			f.mu.Lock()
			if f.runtimeCalls != 0 || len(f.hellos) != 2 || len(f.hellos[0].Capabilities) != 0 || !protocol.HasCapability(f.hellos[1].Capabilities, protocol.CapabilityCandidate) {
				t.Error("bootstrap started DSH or bypassed read-only barrier", f.hellos)
			}
			f.mu.Unlock()
			current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
			if err != nil || !exists || current != session || f.account.device.UserID != f.original.UserID {
				t.Fatal("retry changed the durable session/enrollment owner", current, err)
			}
		})
	}
}

func TestBootstrapRepairsReadOnlyOwnerAfterCandidateActivationDialFailure(t *testing.T) {
	f, session := bootstrapFixture(t)
	f.rejectSignalAttempt = 2
	if count := f.host.RestoreOwnCredentials(context.Background()); count != 0 {
		t.Fatal("failed candidate activation claimed restored", count)
	}
	manager := f.account.manager
	if manager == nil || manager.CandidatesActive() {
		t.Fatal("activation failure did not retain the original read-only manager")
	}
	job := onlyBootstrap(t, f)
	duplicate, err := f.host.captureBootstrap(f.account.identity.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	f.host.scheduleCapturedBootstrap(duplicate)
	if onlyBootstrap(t, f) != job {
		t.Fatal("activation failure created a second bootstrap owner")
	}
	select {
	case <-job.done:
	case <-time.After(3 * time.Second):
		t.Fatal("bootstrap did not repair its closed read-only subscription through normal backoff")
	}
	if f.account.manager != manager || !manager.CandidatesActive() {
		t.Fatal("subscription recovery replaced the manager or remained read-only")
	}
	f.mu.Lock()
	hellos := append([]protocol.ControlHello(nil), f.hellos...)
	requests := append([]protocol.PairIdentityRequest(nil), f.identityRequests...)
	attempts := append([]time.Time(nil), f.signalAttempts...)
	runtimeCalls := f.runtimeCalls
	f.mu.Unlock()
	if runtimeCalls != 0 || len(hellos) != 3 || len(hellos[0].Capabilities) != 0 || len(hellos[1].Capabilities) != 0 ||
		!protocol.HasCapability(hellos[2].Capabilities, protocol.CapabilityCandidate) || len(attempts) != 4 || attempts[2].Sub(attempts[1]) < time.Second {
		t.Fatal("retry bypassed its existing backoff or read-only fresh-pin activation barrier", hellos, attempts)
	}
	for _, hello := range hellos {
		if hello.CoreInstanceID != hellos[0].CoreInstanceID || hello.UserID != f.selectedUserID {
			t.Fatal("retry changed the original core or selected account")
		}
	}
	if len(requests) != 2 || requests[0].Registration == requests[1].Registration || requests[1].UserID != f.selectedUserID {
		t.Fatal("retry reused stale registration or cached pins", requests)
	}
	saved, err := f.host.catalog.Inspect()
	if err != nil || len(saved.Record.Computers) != 1 || saved.Record.Computers[0].UserID != f.selectedUserID || saved.Record.Computers[0].PairState != "active" {
		t.Fatal("fresh retry did not publish the selected scoped catalog", saved, err)
	}
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current != session || f.account.device.UserID != f.original.UserID {
		t.Fatal("subscription repair changed original selected session or enrollment owner", err)
	}
}

func TestLogoutJoinsActivationRetryDuringFreshScopedIdentityRead(t *testing.T) {
	f, session := bootstrapFixture(t)
	f.rejectSignalAttempt = 2
	if count := f.host.RestoreOwnCredentials(context.Background()); count != 0 {
		t.Fatal("failed candidate activation claimed restored", count)
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
		t.Fatal("activation retry did not reach fresh identity under its repaired read-only owner")
	}
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]string{"token": session.Token}})
	loggedOut := make(chan error, 1)
	go func() { _, err := f.host.Handle(context.Background(), "user.logout", payload); loggedOut <- err }()
	select {
	case err := <-loggedOut:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("logout deadlocked with repaired read-only bootstrap")
	}
	select {
	case <-job.done:
	default:
		t.Fatal("logout did not join its cancelled fresh-pin job")
	}
	if f.account.manager.CandidatesActive() || f.account.client.Account() != "" {
		t.Fatal("cancelled identity read activated the old selected account")
	}
	f.mu.Lock()
	hellos := append([]protocol.ControlHello(nil), f.hellos...)
	reads := len(f.identityRequests)
	f.mu.Unlock()
	if len(hellos) != 2 || len(hellos[0].Capabilities) != 0 || len(hellos[1].Capabilities) != 0 || hellos[0].UserID != f.selectedUserID || hellos[1].UserID != f.selectedUserID || reads != 2 {
		t.Fatal("late fresh identity resurrected candidate authority after logout", hellos, reads)
	}
	if _, err := f.account.manager.CurrentRegistration(f.selectedUserID); err == nil || len(f.account.authRecoveryJoins) != 0 || f.account.manager.WorkbenchRequested(f.scopedIdentity.Target.DeviceID) {
		t.Fatal("logout retained its old registration/intent or abandoned a detached join")
	}
	if err := f.account.manager.Pin(*f.scopedIdentity); err == nil {
		t.Fatal("logout retained the previous selected account's pin authority")
	}
	if _, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
		t.Fatal("logout restored its retired durable login", err)
	}
	if _, err := f.host.LoadCredential(f.account.identity.ServiceID); err != nil {
		t.Fatal("cancelling retry deleted the original device", err)
	}
}

func TestBootstrapRecordChangeForgetAndCloseStopOldWork(t *testing.T) {
	for _, action := range []string{"record", "forget", "close", "terminal"} {
		t.Run(action, func(t *testing.T) {
			f, session := bootstrapFixture(t)
			f.serviceCode = "p2p.server_unavailable"
			if action == "terminal" {
				f.serviceCode = "p2p.identity_mismatch"
			}
			if f.host.RestoreOwnCredentials(context.Background()) != 0 {
				t.Fatal("failed bootstrap reported ready")
			}
			if action == "terminal" {
				f.host.bootstrapMu.Lock()
				count := len(f.host.bootstraps)
				f.host.bootstrapMu.Unlock()
				if count != 0 {
					t.Fatal("terminal refusal scheduled an automatic retry")
				}
				return
			}
			job := onlyBootstrap(t, f)
			switch action {
			case "record":
				session.Token = strings.Repeat("b", 64)
				if err := f.host.saveAccountSession(f.account.identity.ServiceID, session); err != nil {
					t.Fatal(err)
				}
			case "forget":
				f.host.ForgetService(f.account.identity.ServiceID)
			case "close":
				f.host.Close()
			}
			select {
			case <-job.done:
			case <-time.After(2 * time.Second):
				t.Fatal("old bootstrap outlived record/owner change")
			}
			if action == "forget" && f.host.RestoreOwnCredentials(context.Background()) != 0 {
				t.Fatal("retained credential resurrected forgotten service")
			}
			f.mu.Lock()
			queries := f.serviceQueries
			f.mu.Unlock()
			if queries != 1 {
				t.Fatal("old work retried a changed scope", queries)
			}
			if _, err := f.host.LoadCredential(f.account.identity.ServiceID); err != nil {
				t.Fatal("stopping retry deleted the enrolled record", err)
			}
		})
	}
}

func TestLogoutCancelsAndJoinsBootstrapBeforeTakingAccountLock(t *testing.T) {
	f, session := bootstrapFixture(t)
	f.serviceCode = "p2p.server_unavailable"
	if f.host.RestoreOwnCredentials(context.Background()) != 0 {
		t.Fatal("unavailable service reported restored")
	}
	job := onlyBootstrap(t, f)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	f.mu.Lock()
	f.serviceCode, f.serviceEntered, f.serviceRelease = "", entered, release
	f.mu.Unlock()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("retry did not reach its owned HTTP operation")
	}
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]string{"token": session.Token}})
	loggedOut := make(chan error, 1)
	go func() { _, err := f.host.Handle(context.Background(), "user.logout", payload); loggedOut <- err }()
	select {
	case err := <-loggedOut:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("account lock/join deadlocked logout")
	}
	select {
	case <-job.done:
	default:
		t.Fatal("logout returned before stale bootstrap joined")
	}
	if _, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
		t.Fatal("logout retained old session authority", err)
	}
}

func TestBootstrapTransientSetDoesNotHideTerminalOrProviderRefusals(t *testing.T) {
	for _, code := range []string{"p2p.rate_limited", "p2p.server_unavailable", "p2p.signalling_not_ready", "p2p.registration_stale"} {
		if !bootstrapTransient(&certificateCarrierFailure{cause: codeError(code)}) {
			t.Fatal("real transient cause was lost", code)
		}
	}
	for _, code := range []string{"p2p.certificate_sync_failed", "p2p.user_unauthorized", "p2p.identity_mismatch", "secret.read_failed", "p2p.protocol_mismatch", "p2p.request_cancelled"} {
		if bootstrapTransient(codeError(code)) {
			t.Fatal("terminal/provider/caller refusal retried", code)
		}
	}
}

type codeError string

func (code codeError) Error() string { return string(code) }
