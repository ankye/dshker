package helper

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func revokedNetworkFixture(t *testing.T) (*certificateFixture, controlplane.PairIdentity) {
	t.Helper()
	f, _ := bootstrapFixture(t)
	if f.host.RestoreOwnCredentials(context.Background()) != 1 {
		t.Fatal("initial selected account was not activated")
	}
	identity := *f.scopedIdentity
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{}
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	saved, err := f.host.catalog.Inspect()
	if err != nil || len(saved.Record.Computers) != 1 || saved.Record.Computers[0].PairState != "revoked" {
		t.Fatal("missing authority did not persist the exact revoked lineage", saved, err)
	}
	return f, identity
}

func TestNetworkSelectionAutomaticallyRecoversExactAuthorizedRevokedNetwork(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	before, _ := f.host.catalog.Inspect()
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	for attempt := range 2 {
		revision, err := f.account.refreshCatalog(context.Background())
		if err != nil {
			t.Fatal("fresh original authority could not automatically converge", err)
		}
		saved, err := f.host.catalog.Inspect()
		if err != nil || len(saved.Record.Computers) != 1 {
			t.Fatal("recovery lost or duplicated the same computer", saved, err)
		}
		computer := saved.Record.Computers[0]
		if computer.PairState != "active" || computer.NetworkID != identity.Pair.NetworkID || computer.UserID != f.selectedUserID ||
			computer.LocalDeviceID != f.original.DeviceID || computer.RemoteDeviceID != identity.Target.DeviceID ||
			computer.LocalPublicKey != encodeKey(identity.Initiator.PublicKey) || computer.RemotePublicKey != encodeKey(identity.Target.PublicKey) ||
			computer.PairRevision != int64(identity.Pair.Revision) || revision != saved.Revision {
			t.Fatal("automatic sync did not persist the exact fresh original authority", computer)
		}
		choice := deviceChoice(t, inspectNetworkChoices(t, f), identity.Target.DeviceID)
		if choice.State != "selected" || choice.SelectedNetworkID != identity.Pair.NetworkID || len(choice.Choices) != 1 {
			t.Fatal("renderer projection still required manual reselection", choice)
		}
		if attempt == 0 && revision == before.Revision {
			t.Fatal("recovery did not durably replace revoked authority")
		}
		if attempt == 1 && revision != before.Revision {
			t.Fatal("repeated confirmation rewrote the already recovered record")
		}
		before = saved
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.runtimeCalls != 0 {
		t.Fatal("restoring network authority started DSH")
	}
}

func TestNetworkSelectionRecoveryFreshReadFailureKeepsRevokedAuthority(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	before, _ := f.host.catalog.Inspect()
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.identityCode = "p2p.server_unavailable"
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err == nil || err.Error() != "p2p.server_unavailable" {
		t.Fatal("failed authority read was hidden", err)
	}
	after, _ := f.host.catalog.Inspect()
	if after.Revision != before.Revision || after.Record.Computers[0].PairState != "revoked" {
		t.Fatal("read failure revived cached authority")
	}
	f.mu.Lock()
	f.identityCode = ""
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	after, _ = f.host.catalog.Inspect()
	if after.Record.Computers[0].PairState != "active" {
		t.Fatal("next automatic confirmation did not recover after a failed read")
	}
}

func TestNetworkSelectionRecoveryCatalogFailureKeepsRevokedAuthority(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	before, _ := f.host.catalog.Inspect()
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	base := f.host.catalog
	fault := &failingNetworkTransitions{CatalogStore: base, failure: catalog.ErrWriteFailed}
	f.host.SetCatalog(fault)
	if _, err := f.account.refreshCatalog(context.Background()); err != catalog.ErrWriteFailed {
		t.Fatal("failed durable publication was hidden", err)
	}
	f.host.SetCatalog(base)
	after, _ := base.Inspect()
	if after.Revision != before.Revision || after.Record.Computers[0].PairState != "revoked" || fault.calls != 1 {
		t.Fatal("failed publication changed the durable selected authority", after, fault.calls)
	}
	if _, err := f.account.manager.Reconnect(context.Background(), identity.Target.DeviceID, f.host.nextGeneration()); err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatal("failed publication admitted an unpublished fresh pin", err)
	}
}

func TestNetworkSelectionRecoveryRequiresExactOriginalIdentity(t *testing.T) {
	for _, field := range []string{"account", "local-device", "remote-device", "local-key", "remote-key", "network", "inactive"} {
		t.Run(field, func(t *testing.T) {
			f, identity := revokedNetworkFixture(t)
			before, _ := f.host.catalog.Inspect()
			switch field {
			case "account":
				identity.Initiator.UserID, identity.Target.UserID = protocol.NewID(), protocol.NewID()
			case "local-device":
				identity.Initiator.DeviceID = protocol.NewID()
				identity.Pair.Initiator = identity.Initiator.DeviceID
			case "remote-device":
				identity.Target.DeviceID = protocol.NewID()
				identity.Pair.Target = identity.Target.DeviceID
			case "local-key":
				identity.Initiator.PublicKey = newKey(t)
			case "remote-key":
				identity.Target.PublicKey = newKey(t)
			case "network":
				identity.Pair.NetworkID = protocol.NewID()
			case "inactive":
				identity.Pair.State = "revoked"
			}
			f.mu.Lock()
			f.scopedIdentities = []controlplane.PairIdentity{identity}
			f.mu.Unlock()
			_, err := f.account.refreshCatalog(context.Background())
			if field == "account" || field == "local-device" || field == "local-key" {
				if err == nil || err.Error() != "p2p.identity_mismatch" {
					t.Fatal("foreign selected identity did not fail closed", err)
				}
			} else if err != nil {
				t.Fatal("valid discovery could not retain unresolved old authority", err)
			}
			after, _ := f.host.catalog.Inspect()
			var found bool
			for _, computer := range after.Record.Computers {
				if computer.ConnectionID == before.Record.Computers[0].ConnectionID {
					found = true
					if computer != before.Record.Computers[0] || computer.PairState != "revoked" {
						t.Fatal("foreign authority overwrote original revoked identity", computer)
					}
				}
			}
			if !found {
				t.Fatal("changed authority erased unresolved original choice")
			}
		})
	}
}

func TestNetworkSelectionRecoveryPersistsAcrossCatalogReopen(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	before, _ := f.host.catalog.Inspect()
	directory := t.TempDir()
	store, err := catalog.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := store.Enable()
	if err != nil {
		t.Fatal(err)
	}
	next := enabled.Record
	next.Services, next.Computers = before.Record.Services, before.Record.Computers
	if _, err := store.Commit(enabled.Revision, next); err != nil {
		t.Fatal(err)
	}
	f.host.SetCatalog(store)
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	revision, err := f.account.refreshCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := catalog.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	readback, err := reopened.Inspect()
	if err != nil || readback.Revision != revision || len(readback.Record.Computers) != 1 ||
		readback.Record.Computers[0].PairState != "active" || readback.Record.Computers[0].NetworkID != identity.Pair.NetworkID {
		t.Fatal("recovered authority did not survive reopening its real store", readback, err)
	}
	f.host.SetCatalog(reopened)
	choice := deviceChoice(t, inspectNetworkChoices(t, f), identity.Target.DeviceID)
	if choice.State != "selected" || choice.SelectedNetworkID != identity.Pair.NetworkID {
		t.Fatal("reopened authority required manual network selection", choice)
	}
}

func TestNetworkSelectionRecoveryReauthorizesOnlyExactEngineIntent(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	f.host.AutoConnectEngine().Close()
	intent := autoconnect.Intent{ServiceID: f.account.identity.ServiceID, PairID: identity.Target.DeviceID}
	foreign := autoconnect.Intent{ServiceID: protocol.NewID(), PairID: identity.Target.DeviceID}
	var connected atomic.Bool
	var calls atomic.Int32
	var foreignCalls atomic.Int32
	confirmed := make(chan struct{}, 1)
	engine := autoconnect.New(autoconnect.Options{
		Intents: func(context.Context) ([]autoconnect.Intent, error) { return []autoconnect.Intent{intent, foreign}, nil },
		Stage: func(serviceID, pairID string) autoconnect.ConnectionState {
			if serviceID == intent.ServiceID && connected.Load() {
				return autoconnect.ConnectionState{Stage: "connected"}
			}
			return autoconnect.ConnectionState{}
		},
		Connect: func(_ context.Context, serviceID, pairID string) error {
			if serviceID != intent.ServiceID {
				foreignCalls.Add(1)
				return errors.New("p2p.pair_revoked")
			}
			calls.Add(1)
			saved, err := f.host.catalog.Inspect()
			if err != nil {
				return err
			}
			if len(saved.Record.Computers) != 1 || saved.Record.Computers[0].PairState != "active" || saved.Record.Computers[0].NetworkID != identity.Pair.NetworkID {
				return errors.New("p2p.pair_revoked")
			}
			connected.Store(true)
			confirmed <- struct{}{}
			return nil
		},
		CodeOf: func(err error) string { return err.Error() },
	})
	f.host.mu.Lock()
	f.host.reconnect = engine
	f.host.mu.Unlock()
	engine.Reconcile(context.Background())
	if code, blocked := engine.Refusal(intent.ServiceID, intent.PairID); !blocked || code != "p2p.pair_revoked" {
		t.Fatal("exact intent did not establish its terminal precondition", code)
	}
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-confirmed:
	case <-time.After(2 * time.Second):
		t.Fatal("durably recovered original scope stayed blocked by its old terminal")
	}
	if calls.Load() != 2 || foreignCalls.Load() != 1 {
		t.Fatal("recovery woke an unrelated service or duplicated the exact attempt", calls.Load(), foreignCalls.Load())
	}
	if code, blocked := engine.Refusal(foreign.ServiceID, foreign.PairID); !blocked || code != "p2p.pair_revoked" {
		t.Fatal("recovery cleared a foreign intent's terminal refusal", code)
	}
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || foreignCalls.Load() != 1 {
		t.Fatal("unchanged refresh reset engine ownership", calls.Load(), foreignCalls.Load())
	}
}

func TestNetworkChoicesReadRecoversRevokedAuthorityBeforeProjection(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	before, _ := f.host.catalog.Inspect()
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	beforeAnnouncements := f.catalogAnnouncements
	f.mu.Unlock()
	view := inspectNetworkChoices(t, f)
	after, err := f.host.catalog.Inspect()
	if err != nil || after.Revision != view.CatalogRevision || after.Revision == before.Revision || after.Record.Computers[0].PairState != "active" {
		t.Fatal("selected projection preceded durable recovery", after, err)
	}
	if deviceChoice(t, view, identity.Target.DeviceID).State != "selected" {
		t.Fatal("read still requested manual selection after recovery")
	}
	if _, err := f.account.manager.Reconnect(context.Background(), identity.Target.DeviceID, f.host.nextGeneration()); err != nil && err.Error() == "p2p.pair_unauthorized" {
		t.Fatal("selected projection preceded current live pin admission")
	}
	view = inspectNetworkChoices(t, f)
	if view.CatalogRevision != after.Revision {
		t.Fatal("ordinary read rewrote recovered authority")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.catalogAnnouncements != beforeAnnouncements+1 {
		t.Fatal("read did not publish exactly one durable catalog invalidation", f.catalogAnnouncements, beforeAnnouncements)
	}
}

func authorizationStopEngine(t *testing.T, f *certificateFixture, identity controlplane.PairIdentity, code string) (*autoconnect.Engine, *atomic.Int32, <-chan struct{}) {
	t.Helper()
	f.host.AutoConnectEngine().Close()
	intent := autoconnect.Intent{ServiceID: f.account.identity.ServiceID, PairID: identity.Target.DeviceID}
	var connected atomic.Bool
	calls := &atomic.Int32{}
	confirmed := make(chan struct{}, 1)
	engine := autoconnect.New(autoconnect.Options{
		Intents: func(context.Context) ([]autoconnect.Intent, error) { return []autoconnect.Intent{intent}, nil },
		Stage: func(string, string) autoconnect.ConnectionState {
			if connected.Load() {
				return autoconnect.ConnectionState{Stage: "connected"}
			}
			return autoconnect.ConnectionState{}
		},
		Connect: func(context.Context, string, string) error {
			if calls.Add(1) == 1 {
				return errors.New(code)
			}
			connected.Store(true)
			confirmed <- struct{}{}
			return nil
		},
		CodeOf: func(err error) string { return err.Error() },
	})
	f.host.mu.Lock()
	f.host.reconnect = engine
	f.host.mu.Unlock()
	engine.Reconcile(context.Background())
	if got, blocked := engine.Refusal(intent.ServiceID, intent.PairID); !blocked || got != code {
		t.Fatal("engine did not establish the exact prior terminal", got)
	}
	return engine, calls, confirmed
}

func TestNetworkSelectionRecoveryLostPublicationReplyUsesFreshExactReadback(t *testing.T) {
	for _, code := range []string{"p2p.pair_unauthorized", "p2p.pair_revoked", "p2p.pair_not_found", "p2p.network_revoked"} {
		t.Run(code, func(t *testing.T) {
			f, identity := revokedNetworkFixture(t)
			engine, calls, confirmed := authorizationStopEngine(t, f, identity, code)
			f.mu.Lock()
			f.scopedIdentities = []controlplane.PairIdentity{identity}
			f.mu.Unlock()
			base := f.host.catalog
			fault := &failingNetworkTransitions{CatalogStore: base, failure: catalog.ErrWriteFailed, after: true}
			f.host.SetCatalog(fault)
			if _, err := f.account.refreshCatalog(context.Background()); err != catalog.ErrWriteFailed {
				t.Fatal("unknown publication outcome claimed success", err)
			}
			f.host.SetCatalog(base)
			saved, _ := base.Inspect()
			if saved.Record.Computers[0].PairState != "active" {
				t.Fatal("lost-reply precondition did not publish its durable state")
			}
			if _, blocked := engine.Refusal(f.account.identity.ServiceID, identity.Target.DeviceID); !blocked {
				t.Fatal("unknown result prematurely cleared the old terminal")
			}
			view := inspectNetworkChoices(t, f)
			if view.CatalogRevision != saved.Revision || deviceChoice(t, view, identity.Target.DeviceID).State != "selected" {
				t.Fatal("fresh readback changed the saved network or its durable revision")
			}
			select {
			case <-confirmed:
			case <-time.After(2 * time.Second):
				t.Fatal("fresh exact readback retained the old authorization stop")
			}
			if calls.Load() != 2 || fault.calls != 1 {
				t.Fatal("publication was blindly replayed or recovery duplicated", calls.Load(), fault.calls)
			}
		})
	}
}

func TestNetworkSelectionRecoveryDoesNotClearUnrelatedTerminal(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	engine, calls, _ := authorizationStopEngine(t, f, identity, "p2p.identity_mismatch")
	view := inspectNetworkChoices(t, f)
	if deviceChoice(t, view, identity.Target.DeviceID).State != "selected" {
		t.Fatal("authorized original network disappeared")
	}
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if code, blocked := engine.Refusal(f.account.identity.ServiceID, identity.Target.DeviceID); !blocked || code != "p2p.identity_mismatch" || calls.Load() != 1 {
		t.Fatal("ordinary sync cleared a non-authorization terminal", code, calls.Load())
	}
}

func TestNetworkSelectionRecoveryRevokedRowKeepsNonAuthorizationTerminal(t *testing.T) {
	for _, code := range []string{"p2p.identity_mismatch", "p2p.trust_restore_rejected", "p2p.lease_rejected", "p2p.device_revoked", "p2p.unauthorized"} {
		t.Run(code, func(t *testing.T) {
			f, identity := revokedNetworkFixture(t)
			engine, calls, _ := authorizationStopEngine(t, f, identity, code)
			f.account.mu.Lock()
			f.account.stages = map[string]string{identity.Target.DeviceID: "failed"}
			f.account.refusals = map[string]string{identity.Target.DeviceID: code}
			f.account.mu.Unlock()
			f.mu.Lock()
			f.scopedIdentities = []controlplane.PairIdentity{identity}
			f.mu.Unlock()
			view := inspectNetworkChoices(t, f)
			saved, err := f.host.catalog.Inspect()
			if err != nil || saved.Record.Computers[0].PairState != "active" || deviceChoice(t, view, identity.Target.DeviceID).State != "selected" {
				t.Fatal("unrelated terminal prevented original network-state convergence", saved, err)
			}
			if got, blocked := engine.Refusal(f.account.identity.ServiceID, identity.Target.DeviceID); !blocked || got != code || calls.Load() != 1 {
				t.Fatal("recovering a revoked row cleared an unrelated engine terminal", got, calls.Load())
			}
			f.account.mu.Lock()
			stage, refusal := f.account.stages[identity.Target.DeviceID], f.account.refusals[identity.Target.DeviceID]
			f.account.mu.Unlock()
			if stage != "failed" || refusal != code {
				t.Fatal("recovering network authority cleared another first-cause projection", stage, refusal)
			}
		})
	}
}

func TestNetworkSelectionRecoveryActivationFailureDoesNotStrandDurableAuthority(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	engine, _, _ := authorizationStopEngine(t, f, identity, "p2p.pair_revoked")
	completion, err := f.account.manager.FenceAccountForCertificateRecovery(f.selectedUserID)
	if err != nil {
		t.Fatal(err)
	}
	completion.Wait()
	if err := f.account.manager.ReconnectSignals(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.rejectSignalAttempt = len(f.signalAttempts) + 1
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err == nil {
		t.Fatal("candidate activation failure was hidden")
	}
	after, _ := f.host.catalog.Inspect()
	if after.Record.Computers[0].PairState != "active" || f.account.manager.CandidatesActive() {
		t.Fatal("activation failure did not keep its durable but inactive recovery state")
	}
	if _, blocked := engine.Refusal(f.account.identity.ServiceID, identity.Target.DeviceID); blocked {
		t.Fatal("successful durable recovery retained the old authorization stop")
	}
	if err := f.account.manager.ReconnectSignals(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal("later automatic synchronization did not finish activation", err)
	}
	if !f.account.manager.CandidatesActive() {
		t.Fatal("durable active authority remained unable to admit candidates")
	}
}

func TestNetworkSelectionRecoveryLostReplyWithoutTerminalRestoresLivePin(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	if code, blocked := f.host.AutoConnectEngine().Refusal(f.account.identity.ServiceID, identity.Target.DeviceID); blocked {
		t.Fatal("unexpected pre-existing engine stop", code)
	}
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	base := f.host.catalog
	fault := &failingNetworkTransitions{CatalogStore: base, failure: catalog.ErrWriteFailed, after: true}
	f.host.SetCatalog(fault)
	_, err := f.account.refreshCatalog(context.Background())
	f.host.SetCatalog(base)
	if err != catalog.ErrWriteFailed {
		t.Fatal("unknown publication result claimed success", err)
	}
	saved, _ := base.Inspect()
	if saved.Record.Computers[0].PairState != "active" {
		t.Fatal("lost reply did not leave its durable active record")
	}
	if _, err := f.account.manager.Reconnect(context.Background(), identity.Target.DeviceID, f.host.nextGeneration()); err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatal("unknown publication failed to roll back its unconfirmed pin", err)
	}
	view := inspectNetworkChoices(t, f)
	if view.CatalogRevision != saved.Revision || deviceChoice(t, view, identity.Target.DeviceID).State != "selected" {
		t.Fatal("fresh readback rewrote the original durable choice")
	}
	if _, err := f.account.manager.Reconnect(context.Background(), identity.Target.DeviceID, f.host.nextGeneration()); err != nil && err.Error() == "p2p.pair_unauthorized" {
		t.Fatal("selected readback still lacked its fresh live pin", err)
	}
}

func TestNetworkSelectionRecoveryFreshReplyRejectsActualLogout(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	saved, _ := f.host.catalog.Inspect()
	session, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists {
		t.Fatal("selected session missing", err)
	}
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.loginSession = &controlplane.UserSession{Token: session.Token, ExpiresAt: session.ExpiresAt, User: controlplane.User{UserID: f.selectedUserID, Username: "selected@example.test"}}
	f.grantSessionToken = session.Token
	f.mu.Unlock()
	f.host.SetDeviceKeys(&logoutFailureStore{memoryStore: f.store, sessionKey: accountSessionPrefix + f.account.identity.ServiceID, deleteFails: true})
	b := selectedAuthorityBarrier(t, f, "/v2/pairs/identity", 1)
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{}})
	done := make(chan consumerAuthorityResult, 1)
	go func() {
		value, err := f.host.Handle(context.Background(), "pairs.network_choices", payload)
		done <- consumerAuthorityResult{value, err}
	}()
	consumerAuthorityWait(t, "revoked network fresh identity", b.entered)
	logoutDone := consumerAuthorityRevoke(t, f, session)
	b.once.Do(func() { close(b.release) })
	result := consumerAuthorityReceive(t, done)
	consumerAuthorityWait(t, "logout before local cleanup", b.logoutEntered)
	if result.err == nil || result.err.Error() != "p2p.user_scope_mismatch" || result.value != nil {
		t.Error("late fresh reply restored a logged-out network", result.err)
	}
	after, err := f.host.catalog.Inspect()
	if err != nil || after.Revision != saved.Revision || after.Record.Computers[0].PairState != "revoked" {
		t.Error("late recovery published after its selected session was revoked", after, err)
	}
	consumerAuthorityFinishLogout(t, f, session, b, logoutDone)
}

func TestNetworkSelectionRecoveryCatalogConflictPreservesConcurrentRecord(t *testing.T) {
	f, identity := revokedNetworkFixture(t)
	before, _ := f.host.catalog.Inspect()
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{identity}
	f.mu.Unlock()
	b := selectedAuthorityBarrier(t, f, "/v2/pairs/identity", 1)
	done := make(chan error, 1)
	go func() {
		_, err := f.account.refreshCatalog(context.Background())
		done <- err
	}()
	consumerAuthorityWait(t, "recovery before concurrent catalog publication", b.entered)
	next := before.Record
	next.Services = append([]catalog.Service(nil), next.Services...)
	next.Services[0].DisplayName = "concurrent service name"
	concurrent, err := f.host.catalog.Commit(before.Revision, next)
	if err != nil {
		t.Fatal(err)
	}
	b.once.Do(func() { close(b.release) })
	select {
	case err := <-done:
		if err != catalog.ErrConflict {
			t.Fatal("fresh recovery overwrote a concurrent catalog revision", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("conflicting recovery did not join")
	}
	after, _ := f.host.catalog.Inspect()
	if after.Revision != concurrent.Revision || after.Record.Computers[0].PairState != "revoked" || after.Record.Services[0].DisplayName != next.Services[0].DisplayName {
		t.Fatal("failed recovery lost concurrent data or published active authority", after)
	}
	if _, err := f.account.manager.Reconnect(context.Background(), identity.Target.DeviceID, f.host.nextGeneration()); err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatal("conflicting recovery published a live pin", err)
	}
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal("next automatic synchronization did not recover from conflict", err)
	}
	after, _ = f.host.catalog.Inspect()
	if after.Record.Computers[0].PairState != "active" || after.Record.Services[0].DisplayName != next.Services[0].DisplayName {
		t.Fatal("successful recovery lost the concurrent service update", after)
	}
}
