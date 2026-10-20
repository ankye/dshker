package helper

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func multiNetworkFixture(t *testing.T) (*certificateFixture, controlplane.PairIdentity, controlplane.PairIdentity) {
	t.Helper()
	f, _ := bootstrapFixture(t)
	first := *f.scopedIdentity
	second := first
	second.Pair.PairID, second.Pair.NetworkID = protocol.NewID(), protocol.NewID()
	other, _ := plantedPair(t, f.original.DeviceID, f.selectedUserID, f.original.PublicKey, "single-network remote", f.networkID)
	f.scopedIdentities = []controlplane.PairIdentity{first, second, other}
	f.networks = []controlplane.Network{{NetworkID: first.Pair.NetworkID, UserID: f.selectedUserID, Name: "network one", MaxDevices: 10}, {NetworkID: second.Pair.NetworkID, UserID: f.selectedUserID, Name: "network two", MaxDevices: 10}}
	if f.host.RestoreOwnCredentials(context.Background()) != 1 {
		t.Fatal("ambiguous remote blocked the service's other authorized computer")
	}
	return f, first, second
}

func networkOperation(t *testing.T, f *certificateFixture, method string, data any) (NetworkChoices, error) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": data})
	if err != nil {
		t.Fatal(err)
	}
	result, err := f.host.Handle(context.Background(), method, payload)
	if err != nil {
		return NetworkChoices{}, err
	}
	view, ok := result.(NetworkChoices)
	if !ok {
		t.Fatal("network operation did not return the named envelope", result)
	}
	return view, nil
}

func inspectNetworkChoices(t *testing.T, f *certificateFixture) NetworkChoices {
	t.Helper()
	view, err := networkOperation(t, f, "pairs.network_choices", struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func chooseNetwork(t *testing.T, f *certificateFixture, pairID, networkID, revision string) (NetworkChoices, error) {
	t.Helper()
	return networkOperation(t, f, "pairs.select_network", map[string]string{"pairId": pairID, "networkId": networkID, "userId": f.selectedUserID, "expectedRevision": revision})
}

func deviceChoice(t *testing.T, view NetworkChoices, pairID string) DeviceNetworkChoices {
	t.Helper()
	for _, device := range view.Devices {
		if device.PairID == pairID {
			return device
		}
	}
	t.Fatal("fresh authorized remote missing from all-groups view", pairID)
	return DeviceNetworkChoices{}
}

func TestNetworkChoicesDoNotInferFirstNetworkOrBlockOtherComputers(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	view := inspectNetworkChoices(t, f)
	device := deviceChoice(t, view, first.Target.DeviceID)
	if view.UserID != f.selectedUserID || len(view.Devices) != 2 || device.State != "required" || device.SelectedNetworkID != "" || len(device.Choices) != 2 || !f.account.manager.CandidatesActive() {
		t.Fatal("ambiguous choice was inferred or service admission blocked", view)
	}
	saved, err := f.host.catalog.Inspect()
	if err != nil || len(saved.Record.Computers) != 1 || saved.Record.Computers[0].RemoteDeviceID == first.Target.DeviceID {
		t.Fatal("ambiguous device gained a persisted active intent", saved, err)
	}
	if _, err := f.account.manager.Reconnect(context.Background(), first.Target.DeviceID, f.host.nextGeneration()); err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatal("ambiguous device obtained a live pin", err)
	}
	encoded, _ := json.Marshal(view)
	if strings.Contains(string(encoded), first.Pair.PairID) || strings.Contains(string(encoded), second.Pair.PairID) || strings.Contains(string(encoded), "publicKey") || strings.Contains(string(encoded), "token") {
		t.Fatal("selection projection exposed internal identity/credential authority")
	}
	view2 := inspectNetworkChoices(t, f)
	if view2.CatalogRevision != view.CatalogRevision {
		t.Fatal("read-only choices mutated the catalog")
	}
}

func TestNetworkSelectionPersistsExactChoiceAndLostReplyReadbackIsIdempotent(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	before := inspectNetworkChoices(t, f)
	selected, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, before.CatalogRevision)
	if err != nil {
		t.Fatal(err)
	}
	device := deviceChoice(t, selected, first.Target.DeviceID)
	if device.State != "selected" || device.SelectedNetworkID != second.Pair.NetworkID || selected.CatalogRevision == before.CatalogRevision {
		t.Fatal("exact chosen network was not persisted", selected)
	}
	replayed, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, before.CatalogRevision)
	if err != nil || replayed.CatalogRevision != selected.CatalogRevision {
		t.Fatal("lost response could not read back the same committed choice", err)
	}
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, before.CatalogRevision); err == nil || err.Error() != "p2p.network_selection_conflict" {
		t.Fatal("still-authorized saved choice was silently switched", err)
	}
	f.account.mu.Lock()
	_, err = f.account.refreshCatalogLocked(context.Background())
	f.account.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := f.host.catalog.Inspect()
	count := 0
	for _, computer := range saved.Record.Computers {
		if computer.RemoteDeviceID == first.Target.DeviceID {
			count++
			if computer.NetworkID != second.Pair.NetworkID || computer.PairState != "active" {
				t.Fatal("ordinary refresh did not retain the fresh authorized exact network")
			}
		}
	}
	if count != 1 {
		t.Fatal("one computer became multiple connection records", count)
	}
}

func TestNetworkSelectionConcurrentDifferentChoicesCannotBothCommit(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	view := inspectNetworkChoices(t, f)
	var group sync.WaitGroup
	results := make(chan error, 2)
	for _, networkID := range []string{first.Pair.NetworkID, second.Pair.NetworkID} {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := chooseNetwork(t, f, first.Target.DeviceID, networkID, view.CatalogRevision)
			results <- err
		}()
	}
	group.Wait()
	close(results)
	var success, conflict int
	for err := range results {
		if err == nil {
			success++
		} else if err.Error() == "p2p.network_selection_conflict" {
			conflict++
		} else {
			t.Fatal("unexpected concurrent choice outcome", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("concurrent choices did not share one CAS", success, conflict)
	}
}

func TestNetworkSelectionStaleAuthorityRequiresExplicitReselectAndLegalRetirement(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	view := inspectNetworkChoices(t, f)
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, view.CatalogRevision); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.scopedIdentities = append([]controlplane.PairIdentity{second}, f.scopedIdentities[2:]...)
	f.mu.Unlock()
	for range 2 {
		if _, err := f.account.refreshCatalog(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	stale := inspectNetworkChoices(t, f)
	device := deviceChoice(t, stale, first.Target.DeviceID)
	if device.State != "stale" || device.SelectedNetworkID != first.Pair.NetworkID || len(device.Choices) != 1 || device.Choices[0].NetworkID != second.Pair.NetworkID {
		t.Fatal("revoked saved authority silently chose the sole alternative", stale)
	}
	saved, _ := f.host.catalog.Inspect()
	for _, computer := range saved.Record.Computers {
		if computer.RemoteDeviceID == first.Target.DeviceID && (computer.PairState != "revoked" || computer.NetworkID != first.Pair.NetworkID) {
			t.Fatal("stale exact lineage was erased or reactivated")
		}
	}
	selected, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, stale.CatalogRevision)
	if err != nil || deviceChoice(t, selected, first.Target.DeviceID).SelectedNetworkID != second.Pair.NetworkID {
		t.Fatal("explicit reselect did not traverse revoked/drop/fresh transitions", err)
	}
}

func TestNetworkSelectionAccountHandoffNeverOverwritesOldImmutableScope(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	view := inspectNetworkChoices(t, f)
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, view.CatalogRevision); err != nil {
		t.Fatal(err)
	}
	newUser := protocol.NewID()
	second.Initiator.UserID, second.Target.UserID = newUser, newUser
	f.mu.Lock()
	f.selectedUserID = newUser
	f.scopedIdentities = []controlplane.PairIdentity{second}
	f.networks = []controlplane.Network{{NetworkID: second.Pair.NetworkID, UserID: newUser, Name: "new account exact network", MaxDevices: 10}}
	f.mu.Unlock()
	token := strings.Repeat("c", 64)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: token, ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]string{"token": token}})
	if _, err := f.host.Handle(context.Background(), "user.current", payload); err != nil {
		t.Fatal("selected account handoff could not preserve stale old lineage", err)
	}
	stale := inspectNetworkChoices(t, f)
	device := deviceChoice(t, stale, first.Target.DeviceID)
	if device.State != "stale" || device.SelectedNetworkID != first.Pair.NetworkID || stale.UserID != newUser {
		t.Fatal("account handoff inferred a replacement network", stale)
	}
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, stale.CatalogRevision); err != nil {
		t.Fatal(err)
	}
	saved, _ := f.host.catalog.Inspect()
	var active int
	for _, computer := range saved.Record.Computers {
		if computer.PairState == "active" {
			active++
			if computer.UserID != newUser || computer.NetworkID != second.Pair.NetworkID || computer.RemoteDeviceID != first.Target.DeviceID {
				t.Fatal("new selected authority did not retire the exact old scope", saved)
			}
		}
	}
	if active != 1 || f.account.device.UserID != f.original.UserID {
		t.Fatal("account handoff changed enrolled owner or activated stale lineage", saved)
	}
}

func TestNetworkSelectionRetainsLineageAcrossEmptyAuthoritativeDiscovery(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	view := inspectNetworkChoices(t, f)
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, view.CatalogRevision); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{}
	f.mu.Unlock()
	for range 2 {
		if _, err := f.account.refreshCatalog(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	empty := deviceChoice(t, inspectNetworkChoices(t, f), first.Target.DeviceID)
	if empty.State != "stale" || empty.SelectedNetworkID != first.Pair.NetworkID || len(empty.Choices) != 0 {
		t.Fatal("empty discovery erased the explicit saved lineage", empty)
	}
	f.mu.Lock()
	f.scopedIdentities = []controlplane.PairIdentity{second}
	f.mu.Unlock()
	if _, err := f.account.refreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	view = inspectNetworkChoices(t, f)
	stale := deviceChoice(t, view, first.Target.DeviceID)
	if stale.State != "stale" || stale.SelectedNetworkID != first.Pair.NetworkID || len(stale.Choices) != 1 {
		t.Fatal("later single alternative bypassed explicit re-selection", stale)
	}
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, view.CatalogRevision); err != nil {
		t.Fatal(err)
	}
}

type failingNetworkTransitions struct {
	CatalogStore
	failure error
	after   bool
	calls   int
}

func (store *failingNetworkTransitions) CommitTransitions(revision string, steps []catalog.Record) (catalog.Snapshot, error) {
	store.calls++
	if !store.after {
		return catalog.Snapshot{}, store.failure
	}
	committed, err := store.CatalogStore.CommitTransitions(revision, steps)
	if err != nil {
		return committed, err
	}
	return catalog.Snapshot{}, store.failure
}

func TestNetworkReselectionAtomicFailureAndLostPublicationReplyPreserveAuthority(t *testing.T) {
	for _, mode := range []string{"conflict", "write-failure", "lost-reply"} {
		t.Run(mode, func(t *testing.T) {
			f, first, second := multiNetworkFixture(t)
			view := inspectNetworkChoices(t, f)
			if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, view.CatalogRevision); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.scopedIdentities = []controlplane.PairIdentity{second}
			f.mu.Unlock()
			if _, err := f.account.refreshCatalog(context.Background()); err != nil {
				t.Fatal(err)
			}
			before := inspectNetworkChoices(t, f)
			base := f.host.catalog
			failure := catalog.ErrWriteFailed
			if mode == "conflict" {
				failure = catalog.ErrConflict
			}
			fault := &failingNetworkTransitions{CatalogStore: base, failure: failure, after: mode == "lost-reply"}
			f.host.SetCatalog(fault)
			if _, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, before.CatalogRevision); err != failure {
				t.Fatal("atomic selection failure was hidden", err)
			}
			f.host.SetCatalog(base)
			readback := inspectNetworkChoices(t, f)
			current := deviceChoice(t, readback, first.Target.DeviceID)
			if mode == "lost-reply" {
				if current.State != "selected" || current.SelectedNetworkID != second.Pair.NetworkID {
					t.Fatal("publication-unknown could not read back its durable choice")
				}
			} else if readback.CatalogRevision != before.CatalogRevision || current.State != "stale" || current.SelectedNetworkID != first.Pair.NetworkID {
				t.Fatal("failed atomic re-selection lost the original lineage", readback)
			}
			if fault.calls != 1 {
				t.Fatal("selection retried a non-atomic mutation", fault.calls)
			}
			if _, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, before.CatalogRevision); err != nil {
				t.Fatal("same-choice retry could not resolve prior publication outcome", err)
			}
			if _, err := f.account.manager.Reconnect(context.Background(), first.Target.DeviceID, f.host.nextGeneration()); err != nil && err.Error() == "p2p.pair_unauthorized" {
				t.Fatal("durable lost-reply readback failed to re-admit its fresh live pin")
			}
		})
	}
}

func TestNetworkSelectionStrictAdmissionRevisionAndFailedFreshRead(t *testing.T) {
	f, first, _ := multiNetworkFixture(t)
	view := inspectNetworkChoices(t, f)
	for _, request := range []map[string]string{{"pairId": first.Target.DeviceID}, {"pairId": first.Target.DeviceID, "networkId": first.Pair.NetworkID, "userId": f.selectedUserID, "expectedRevision": view.CatalogRevision, "pin": "forbidden"}} {
		if _, err := networkOperation(t, f, "pairs.select_network", request); err == nil || err.Error() != "p2p.invalid_request" {
			t.Fatal("missing/extra fields crossed named selection admission", err)
		}
	}
	if _, err := networkOperation(t, f, "pairs.network_choices", map[string]string{"networkId": first.Pair.NetworkID}); err == nil || err.Error() != "p2p.invalid_request" {
		t.Fatal("choices silently selected a caller network", err)
	}
	if _, err := networkOperation(t, f, "pairs.select_network", map[string]string{"pairId": first.Target.DeviceID, "networkId": first.Pair.NetworkID, "userId": protocol.NewID(), "expectedRevision": view.CatalogRevision}); err == nil || err.Error() != "p2p.user_scope_mismatch" {
		t.Fatal("another account selected a network", err)
	}
	saved, _ := f.host.catalog.Inspect()
	next := saved.Record
	next.Services = append([]catalog.Service(nil), next.Services...)
	next.Services[0].DisplayName = "concurrent catalog update"
	if _, err := f.host.catalog.Commit(saved.Revision, next); err != nil {
		t.Fatal(err)
	}
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, view.CatalogRevision); err == nil || err.Error() != "p2p.catalog_conflict" {
		t.Fatal("stale expected revision committed a choice", err)
	}
	f.mu.Lock()
	f.identityCode = "p2p.server_unavailable"
	f.mu.Unlock()
	if _, err := networkOperation(t, f, "pairs.network_choices", struct{}{}); err == nil || err.Error() != "p2p.server_unavailable" {
		t.Fatal("failed fresh scoped identity fell back to cached choices", err)
	}
}
