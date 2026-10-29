package helper

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type NetworkChoice struct {
	NetworkID string `json:"networkId"`
	Name      string `json:"name"`
}

type DeviceNetworkChoices struct {
	PairID            string          `json:"pairId"`
	Name              string          `json:"name"`
	SelectedNetworkID string          `json:"selectedNetworkId"`
	State             string          `json:"state"`
	Choices           []NetworkChoice `json:"choices"`
}

type NetworkChoices struct {
	UserID          string                 `json:"userId"`
	CatalogRevision string                 `json:"catalogRevision"`
	Devices         []DeviceNetworkChoices `json:"devices"`
}

type networkGroup struct {
	view       DeviceNetworkChoices
	identities map[string]controlplane.PairIdentity
	previous   *catalog.Computer
}

type networkSelection struct {
	scope  *selectedSessionScope
	userID string
	fence  protocol.RegistrationFence
	saved  catalog.Snapshot
	store  CatalogStore
	local  localMember
	groups []*networkGroup
}

func (selection *networkSelection) envelope() NetworkChoices {
	view := NetworkChoices{UserID: selection.userID, CatalogRevision: selection.saved.Revision, Devices: make([]DeviceNetworkChoices, 0, len(selection.groups))}
	for _, group := range selection.groups {
		view.Devices = append(view.Devices, group.view)
	}
	return view
}

// The caller owns account.mu. Every candidate identity is a fresh v2 read; SQL
// row IDs and keys stay inside this owner, never in the choices projection.
func (account *account) readNetworkSelection(ctx context.Context) (*networkSelection, error) {
	store, client, local, serviceID := account.catalogInputsLocked()
	if account.closed || store == nil {
		return nil, errors.New("p2p.catalog_unavailable")
	}
	if client == nil || account.manager == nil {
		return nil, errors.New("p2p.device_unregistered")
	}
	saved, err := store.Inspect()
	if err != nil {
		return nil, err
	}
	if saved == nil {
		return nil, errors.New("p2p.not_enabled")
	}
	registered := false
	for _, service := range saved.Record.Services {
		registered = registered || service.ServiceID == serviceID
	}
	if !registered {
		return nil, errors.New("p2p.service_unregistered")
	}
	userID := client.Account()
	fence, err := account.manager.CurrentRegistration(userID)
	if err != nil {
		return nil, err
	}
	scope, scoped := selectedSessionScopeFromContext(ctx)
	if !scoped {
		if userID == "" {
			return nil, errors.New("p2p.user_login_required")
		}
		scope, err = account.selectedSessionScopeLocked(ctx)
		if err != nil {
			return nil, err
		}
	}
	if scope.account != account || !scope.hasSession && userID != "" {
		return nil, errors.New("p2p.user_scope_mismatch")
	}
	ctx = scope.Context(ctx)
	if err := checkBootstrapContext(ctx); err != nil {
		return nil, err
	}
	selection := &networkSelection{scope: scope, userID: userID, fence: fence, saved: *saved, store: store, local: local}
	if userID == "" {
		selection.groups = savedNetworkGroups(*saved, serviceID, local.deviceID, nil)
		return selection, nil
	}
	names, err := account.selectedNetworkNames(ctx, userID)
	if err != nil {
		return nil, err
	}
	pairs, err := client.Pairs(ctx)
	if fence := checkBootstrapContext(ctx); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	groups := make(map[string]*networkGroup)
	for _, pair := range pairs {
		if pair.State != "active" {
			continue
		}
		if _, allowed := names[pair.NetworkID]; !allowed {
			continue
		}
		identity, err := account.manager.ScopedPairIdentity(ctx, userID, pair.NetworkID, pair.PairID)
		if fence := checkBootstrapContext(ctx); fence != nil {
			return nil, fence
		}
		if err != nil {
			return nil, err
		}
		remote, _, ok := remoteSide(identity, local.deviceID)
		if !ok || identity.Pair.State != "active" {
			return nil, errors.New("p2p.identity_mismatch")
		}
		group := groups[remote.DeviceID]
		if group == nil {
			group = &networkGroup{view: DeviceNetworkChoices{PairID: remote.DeviceID, Name: remote.Name, Choices: []NetworkChoice{}}, identities: make(map[string]controlplane.PairIdentity)}
			groups[remote.DeviceID] = group
		}
		if _, duplicate := group.identities[pair.NetworkID]; duplicate {
			return nil, errors.New("p2p.identity_mismatch")
		}
		group.identities[pair.NetworkID] = identity
		group.view.Choices = append(group.view.Choices, NetworkChoice{NetworkID: pair.NetworkID, Name: names[pair.NetworkID]})
	}
	selection.groups = savedNetworkGroups(*saved, serviceID, local.deviceID, groups)
	for _, group := range selection.groups {
		sort.Slice(group.view.Choices, func(a, b int) bool { return group.view.Choices[a].NetworkID < group.view.Choices[b].NetworkID })
		setNetworkGroupState(group, userID)
	}
	sort.Slice(selection.groups, func(a, b int) bool { return selection.groups[a].view.PairID < selection.groups[b].view.PairID })
	current, err := account.manager.CurrentRegistration(userID)
	if err != nil {
		return nil, err
	}
	if current != fence {
		return nil, errors.New("p2p.registration_stale")
	}
	if err := checkBootstrapContext(ctx); err != nil {
		return nil, err
	}
	return selection, nil
}

func savedNetworkGroups(saved catalog.Snapshot, serviceID, localDeviceID string, groups map[string]*networkGroup) []*networkGroup {
	if groups == nil {
		groups = make(map[string]*networkGroup)
	}
	for _, computer := range saved.Record.Computers {
		if computer.ServiceID != serviceID || computer.RemoteDeviceID == localDeviceID {
			continue
		}
		group := groups[computer.RemoteDeviceID]
		if group == nil {
			group = &networkGroup{view: DeviceNetworkChoices{PairID: computer.RemoteDeviceID, Name: computer.DisplayName, Choices: []NetworkChoice{}}, identities: make(map[string]controlplane.PairIdentity)}
			groups[computer.RemoteDeviceID] = group
		}
		previous := computer
		group.previous = &previous
		setNetworkGroupState(group, "") // No fresh identity cannot authorize a pin.
	}
	all := make([]*networkGroup, 0, len(groups))
	for _, group := range groups {
		all = append(all, group)
	}
	sort.Slice(all, func(a, b int) bool { return all[a].view.PairID < all[b].view.PairID })
	return all
}

func setNetworkGroupState(group *networkGroup, userID string) {
	if previous := group.previous; previous != nil {
		group.view.SelectedNetworkID = previous.NetworkID
		identity, authorized := group.identities[previous.NetworkID]
		if previous.UserID == userID && authorized && (previous.PairState == "active" || previous.PairState == "revoked" && matchesSavedNetwork(*previous, identity, userID)) {
			group.view.State = "selected"
		} else {
			group.view.State = "stale"
		}
		return
	}
	if len(group.view.Choices) == 1 {
		group.view.State, group.view.SelectedNetworkID = "selected", group.view.Choices[0].NetworkID
	} else {
		group.view.State, group.view.SelectedNetworkID = "required", ""
	}
}

// A locally revoked row is not fresh authority, but it is the user's original
// choice. Recover only that exact identity after the coordinator authorizes it
// again; another network, account, device or key still requires an explicit choice.
func matchesSavedNetwork(previous catalog.Computer, identity controlplane.PairIdentity, userID string) bool {
	remote, local, ok := remoteSide(identity, previous.LocalDeviceID)
	return ok && previous.UserID == userID &&
		identity.Pair.State == "active" && identity.Pair.NetworkID == previous.NetworkID &&
		local.UserID == userID && remote.UserID == userID &&
		local.DeviceID == previous.LocalDeviceID && remote.DeviceID == previous.RemoteDeviceID &&
		previous.LocalPublicKey == encodeKey(local.PublicKey) && previous.RemotePublicKey == encodeKey(remote.PublicKey)
}

func (account *account) recoversNetworkGroup(group *networkGroup, userID string) bool {
	if group.view.State != "selected" || group.previous == nil || !matchesSavedNetwork(*group.previous, group.identities[group.view.SelectedNetworkID], userID) {
		return false
	}
	if group.previous.PairState == "revoked" {
		return true
	}
	// A lost store reply can leave a durable active row while its old admission
	// remains refused. Fresh exact authority can recover only authorization stops;
	// transport, identity and unrelated terminal failures keep their owners.
	code, blocked := account.host.AutoConnectEngine().Refusal(account.identity.ServiceID, group.view.PairID)
	return blocked && networkAuthorizationRefusal(code)
}

func networkAuthorizationRefusal(code string) bool {
	return code == "p2p.pair_unauthorized" || code == "p2p.pair_revoked" || code == "p2p.pair_not_found" || code == "p2p.network_revoked"
}

func (account *account) commitNetworkSelection(ctx context.Context, selection *networkSelection, reselect string) (string, error) {
	ctx = selection.scope.Context(ctx)
	if err := checkBootstrapContext(ctx); err != nil {
		return "", err
	}
	var members []controlplane.PairIdentity
	var livePins []string
	var recovered []string
	for _, group := range selection.groups {
		if group.view.State == "selected" {
			members = append(members, group.identities[group.view.SelectedNetworkID])
			livePins = append(livePins, group.view.PairID)
			if account.recoversNetworkGroup(group, selection.userID) {
				recovered = append(recovered, group.view.PairID)
			}
		} else if group.previous != nil {
			if err := account.manager.RetireScopedPin(group.view.PairID, group.previous.NetworkID); err != nil {
				return "", err
			}
			delete(account.stages, group.view.PairID)
			delete(account.refusals, group.view.PairID)
		}
	}
	var revision string
	err := account.manager.CommitScopedPins(selection.fence, selection.userID, members, func() error {
		return selection.scope.Publish(ctx, func() error {
			saved := selection.saved
			var steps []catalog.Record
			if reselect != "" {
				for index, computer := range saved.Record.Computers {
					if computer.ServiceID != account.identity.ServiceID || computer.RemoteDeviceID != reselect {
						continue
					}
					if computer.PairState != "revoked" {
						next := saved.Record
						next.Computers = append([]catalog.Computer(nil), saved.Record.Computers...)
						next.Computers[index].PairState = "revoked"
						steps = append(steps, next)
						saved.Record = next
					}
					saved.Record = withoutComputers(saved.Record, []catalog.Computer{computer})
					steps = append(steps, saved.Record)
					break
				}
			}
			plan := planMembers(saved, account.identity.ServiceID, selection.local, members)
			// Keep an unresolved stale choice's exact revoked lineage. A later sweep
			// cannot erase it and accidentally turn one alternative into a default.
			for _, group := range selection.groups {
				if group.view.State != "stale" || group.previous == nil || group.previous.PairState != "revoked" {
					continue
				}
				plan.final = append(plan.final, *group.previous)
			}
			if len(plan.retired) > 0 {
				steps = append(steps, withoutComputers(saved.Record, plan.retired))
			}
			next := saved.Record
			next.Computers = plan.final
			steps = append(steps, next)
			committed, err := selection.store.CommitTransitions(selection.saved.Revision, steps)
			if err == nil {
				revision = committed.Revision
			}
			return err
		})
	})
	if err != nil {
		return "", err
	}
	if err := checkBootstrapContext(ctx); err != nil {
		return "", err
	}
	account.manager.RetainPins(livePins)
	// Publish recovery before activation: a failed WSS upgrade must not leave the
	// now-active durable row carrying its former terminal refusal forever.
	for _, pairID := range recovered {
		if err := checkBootstrapContext(ctx); err != nil {
			return "", err
		}
		engine := account.host.AutoConnectEngine()
		if code := account.refusals[pairID]; code != "" && !networkAuthorizationRefusal(code) {
			continue
		}
		if !engine.RecoverAuthorization(autoconnect.Intent{ServiceID: account.identity.ServiceID, PairID: pairID}) {
			continue
		}
		delete(account.stages, pairID)
		delete(account.refusals, pairID)
	}
	if selection.userID != "" {
		if err := checkBootstrapContext(ctx); err != nil {
			return "", err
		}
		if err := account.manager.ActivateCandidates(ctx); err != nil {
			return "", err
		}
		if err := checkBootstrapContext(ctx); err != nil {
			return "", err
		}
	}
	return revision, nil
}

func (account *account) networkSelectionOperation(ctx context.Context, method string, data json.RawMessage) (any, error) {
	var request struct {
		PairID           string `json:"pairId"`
		NetworkID        string `json:"networkId"`
		UserID           string `json:"userId"`
		ExpectedRevision string `json:"expectedRevision"`
	}
	if method == "pairs.network_choices" {
		var empty struct{}
		if protocol.DecodeExact(data, &empty) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
	} else {
		if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.PairID) || !protocol.ValidID(request.NetworkID) || !protocol.ValidID(request.UserID) {
			return nil, errors.New("p2p.invalid_request")
		}
		decoded, err := hex.DecodeString(request.ExpectedRevision)
		if err != nil || len(decoded) != 32 || request.ExpectedRevision != hex.EncodeToString(decoded) {
			return nil, errors.New("p2p.invalid_request")
		}
		if account.client == nil || account.client.Account() != request.UserID {
			return nil, errors.New("p2p.user_scope_mismatch")
		}
	}
	fresh, err := account.readNetworkSelection(ctx)
	if err != nil {
		return nil, err
	}
	if fresh.userID == "" {
		return nil, errors.New("p2p.user_login_required")
	}
	ctx = fresh.scope.Context(ctx)
	if method == "pairs.network_choices" {
		// Publish fresh pins even when a prior store reply was lost after its
		// durable write. An unchanged catalog is a no-op CAS, never a new choice.
		revision, err := account.commitNetworkSelection(ctx, fresh, "")
		if err != nil {
			return nil, err
		}
		previousRevision := fresh.saved.Revision
		fresh.saved.Revision = revision
		if previousRevision != revision {
			if err := fresh.scope.Publish(ctx, func() error { account.catalogRevision = revision; return nil }); err != nil {
				return nil, err
			}
			account.host.announceCatalog(account.identity.ServiceID, revision)
		}
		return fresh.project(ctx)
	}
	var selected *networkGroup
	for _, group := range fresh.groups {
		if group.view.PairID == request.PairID {
			selected = group
			break
		}
	}
	if selected == nil {
		return nil, errors.New("p2p.network_selection_stale")
	}
	if selected.previous != nil && selected.view.State == "selected" {
		if selected.view.SelectedNetworkID != request.NetworkID {
			return nil, errors.New("p2p.network_selection_conflict")
		}
		// A lost publication response may have rolled back unpublished live pins.
		// Re-admit this same durable choice through the fresh owner barrier.
		revision, err := account.commitNetworkSelection(ctx, fresh, "")
		if err != nil {
			return nil, err
		}
		fresh.saved.Revision = revision
		account.host.AutoConnectEngine().Reauthorize(autoconnect.Intent{ServiceID: account.identity.ServiceID, PairID: request.PairID})
		return fresh.project(ctx)
	}
	if fresh.saved.Revision != request.ExpectedRevision {
		return nil, catalog.ErrConflict
	}
	if _, allowed := selected.identities[request.NetworkID]; !allowed {
		return nil, errors.New("p2p.network_selection_stale")
	}
	var reselect string
	if selected.previous != nil {
		reselect = request.PairID
		if err := account.manager.RetireScopedPin(request.PairID, selected.previous.NetworkID); err != nil {
			return nil, err
		}
		delete(account.stages, request.PairID)
		delete(account.refusals, request.PairID)
	}
	selected.view.State, selected.view.SelectedNetworkID = "selected", request.NetworkID
	revision, err := account.commitNetworkSelection(ctx, fresh, reselect)
	if err != nil {
		return nil, err
	}
	fresh.saved.Revision = revision
	if err := fresh.scope.Publish(ctx, func() error { account.catalogRevision = revision; return nil }); err != nil {
		return nil, err
	}
	account.host.announceCatalog(account.identity.ServiceID, revision)
	if err := checkBootstrapContext(ctx); err != nil {
		return nil, err
	}
	account.host.AutoConnectEngine().Reauthorize(autoconnect.Intent{ServiceID: account.identity.ServiceID, PairID: request.PairID})
	return fresh.project(ctx)
}

func (selection *networkSelection) project(ctx context.Context) (any, error) {
	var view NetworkChoices
	err := selection.scope.Publish(ctx, func() error { view = selection.envelope(); return nil })
	if err != nil {
		return nil, err
	}
	return view, nil
}
