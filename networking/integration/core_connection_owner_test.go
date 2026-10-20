package integration

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Shared verbatim with the live D24 driver: these helpers observe the exact
// attached core, completed transport and catalog before opening a workbench.
type recoveryCatalogView struct {
	Enabled  bool           `json:"enabled"`
	Revision string         `json:"revision"`
	Record   catalog.Record `json:"record"`
}

type recoveryCoreCall func(context.Context, string, any) (json.RawMessage, error)

func recoveryReadInitialIntent(ctx context.Context, call recoveryCoreCall, f *realCoordinator) error {
	raw, err := call(ctx, "core.catalog_inspect", struct{}{})
	if err != nil {
		return err
	}
	var current recoveryCatalogView
	if protocol.DecodeExact(raw, &current) != nil || !current.Enabled || current.Revision == "" ||
		len(current.Record.Services) != 1 || len(current.Record.Computers) != 1 || len(current.Record.ForgottenServiceIDs) != 0 {
		return errors.New("test.initial_catalog_scope_mismatch")
	}
	local, remote, pin := f.config[0].Device, f.config[1].Device, f.config[0].Pin
	localPin, remotePin := pin.Initiator, pin.Target
	if localPin.DeviceID != local.DeviceID {
		localPin, remotePin = remotePin, localPin
	}
	revision, revisionErr := hex.DecodeString(current.Revision)
	if revisionErr != nil || len(revision) != 32 || !protocol.ValidID(f.authority.ServiceID) || len(f.authority.PublicKey) != 32 || len(f.authority.Certificate) == 0 ||
		f.userSession.Token == "" || f.userSession.ExpiresAt <= time.Now().Unix() || !protocol.ValidID(f.userSession.User.UserID) ||
		localPin.UserID != f.userSession.User.UserID || remotePin.UserID != f.userSession.User.UserID || pin.Pair.State != "active" || pin.Pair.Revision == 0 ||
		!protocol.ValidID(pin.Pair.NetworkID) || !protocol.ValidID(local.DeviceID) || !protocol.ValidID(remote.DeviceID) || local.DeviceID == remote.DeviceID ||
		localPin.DeviceID != local.DeviceID || remotePin.DeviceID != remote.DeviceID || len(local.PublicKey) != 32 || len(remote.PublicKey) != 32 ||
		base64.StdEncoding.EncodeToString(localPin.PublicKey) != base64.StdEncoding.EncodeToString(local.PublicKey) || base64.StdEncoding.EncodeToString(remotePin.PublicKey) != base64.StdEncoding.EncodeToString(remote.PublicKey) {
		return errors.New("test.initial_account_scope_mismatch")
	}
	expected := catalog.Computer{
		ConnectionID: remote.DeviceID, ServiceID: f.authority.ServiceID, DisplayName: remote.Name,
		PairID: remote.DeviceID, NetworkID: pin.Pair.NetworkID, LocalDeviceID: local.DeviceID,
		RemoteDeviceID: remote.DeviceID, UserID: f.userSession.User.UserID,
		LocalPublicKey: base64.StdEncoding.EncodeToString(local.PublicKey), RemotePublicKey: base64.StdEncoding.EncodeToString(remote.PublicKey),
		PairRevision: int64(pin.Pair.Revision), PairState: "active",
	}
	if current.Record.Services[0] != integrationCatalogService(f) || current.Record.Computers[0] != expected {
		return errors.New("test.initial_catalog_scope_mismatch")
	}
	return ctx.Err()
}

// The exact attached Peer is the available core-owner identity. peer.state has
// no account/network/core fields: their scope is checked against this test-owned
// production service's catalog, not invented in the wire response. This observes only;
// it never reconciles, retries, cancels a candidate or starts a timer.
type recoveryBootstrapOwner struct {
	mu      sync.Mutex
	peer    *localrpc.Peer
	pair    string
	current peersession.State
	err     error
	changed chan struct{}
}

func (owner *recoveryBootstrapOwner) observe(state peersession.State) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if state.PairID != owner.pair || !protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) {
		owner.err = errors.New("test.initial_transport_scope_mismatch")
	} else if owner.current.Generation > state.Generation || owner.current.Generation == state.Generation && owner.current.AttemptID != state.AttemptID {
		owner.err = errors.New("test.initial_transport_owner_changed")
	} else {
		owner.current = state
	}
	close(owner.changed)
	owner.changed = make(chan struct{})
}

func recoveryCompletedTransport(state peersession.State, pair string) error {
	if state.PairID != pair || !protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) ||
		state.Stage != "connected" || state.Error != "" || state.RuntimeGeneration != 0 {
		return errors.New("test.initial_transport_not_completed")
	}
	return nil
}

func (owner *recoveryBootstrapOwner) wait(ctx context.Context, peer *localrpc.Peer) (peersession.State, error) {
	for {
		owner.mu.Lock()
		state, changed, err := owner.current, owner.changed, owner.err
		if owner.peer == nil || owner.peer != peer {
			err = errors.New("test.initial_transport_owner_changed")
		}
		owner.mu.Unlock()
		if err != nil {
			return peersession.State{}, err
		}
		if state.Stage == "connected" {
			return state, recoveryCompletedTransport(state, owner.pair)
		}
		if state.Stage != "" && state.Stage != "punching" && state.Stage != "starting-runtime" {
			return peersession.State{}, errors.New("test.initial_transport_not_completed")
		}
		select {
		case <-ctx.Done():
			return peersession.State{}, ctx.Err()
		case <-changed:
		}
	}
}

func (owner *recoveryBootstrapOwner) check(peer *localrpc.Peer, prior, opened peersession.State) error {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.err != nil {
		return owner.err
	}
	if owner.peer == nil || owner.peer != peer {
		return errors.New("test.initial_transport_owner_changed")
	}
	if owner.current == prior {
		return nil
	}
	// After dispatch the exact new business attempt may already be emitting.
	if opened.AttemptID != "" && owner.current.AttemptID == opened.AttemptID && owner.current.Generation == opened.Generation &&
		owner.current.PairID == opened.PairID && owner.current.Error == "" &&
		(owner.current.Stage == "punching" || owner.current.Stage == "starting-runtime" || owner.current.Stage == "ready") {
		return nil
	}
	return errors.New("test.initial_transport_owner_changed")
}

func recoveryInitialGeneration(completed peersession.State, pair string) (uint64, error) {
	if recoveryCompletedTransport(completed, pair) != nil || !protocol.ValidGeneration(completed.Generation+1) {
		return 0, errors.New("test.initial_generation_invalid")
	}
	return completed.Generation + 1, nil
}

func recoveryInitialBusinessOpen(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner) (peersession.Connected, error) {
	completed, err := recoveryInitialBarrier(ctx, peer, call, f, owner)
	if err != nil {
		return peersession.Connected{}, err
	}
	return recoveryOpenCompletedInitial(ctx, peer, call, f, owner, completed)
}

func recoveryInitialBarrier(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner) (peersession.State, error) {
	if peer == nil || owner == nil {
		return peersession.State{}, errors.New("test.initial_owner_required")
	}
	if err := ctx.Err(); err != nil {
		return peersession.State{}, err
	}
	completed, err := owner.wait(ctx, peer)
	if err != nil {
		return peersession.State{}, err
	}
	if err := recoveryCompletedTransport(completed, f.config[1].Device.DeviceID); err != nil {
		return peersession.State{}, err
	}
	if err := recoveryReadInitialIntent(ctx, call, f); err != nil {
		return peersession.State{}, err
	}
	if err := owner.check(peer, completed, peersession.State{}); err != nil {
		return peersession.State{}, err
	}
	return completed, ctx.Err()
}

// The actual cross driver calls this phase router. Every serve phase shares
// the same read-only barrier; core-crash alone has no Windows business intent.
func recoveryInitializeCross(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner, phase string, reverse func() error) (peersession.Connected, error) {
	switch phase {
	case "forward-stress":
		if reverse != nil {
			return peersession.Connected{}, errors.New("test.initial_reverse_not_allowed")
		}
	case "duplex", "network-fault", "program-pause", "core-crash":
		if reverse == nil {
			return peersession.Connected{}, errors.New("test.initial_reverse_required")
		}
	default:
		return peersession.Connected{}, errors.New("test.initial_phase_invalid")
	}
	completed, err := recoveryInitialBarrier(ctx, peer, call, f, owner)
	if err != nil {
		return peersession.Connected{}, err
	}
	var first peersession.Connected
	if phase != "core-crash" {
		first, err = recoveryOpenCompletedInitial(ctx, peer, call, f, owner, completed)
		if err != nil {
			return first, err
		}
	}
	if err := ctx.Err(); err != nil {
		return first, err
	}
	if reverse != nil {
		err = reverse()
	}
	return first, err
}

func recoveryOpenCompletedInitial(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner, completed peersession.State) (peersession.Connected, error) {
	pair := f.config[1].Device.DeviceID
	generation, err := recoveryInitialGeneration(completed, pair)
	if err != nil {
		return peersession.Connected{}, err
	}
	if err := owner.check(peer, completed, peersession.State{}); err != nil {
		return peersession.Connected{}, err
	}
	raw, err := call(ctx, "peer.connect", map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{
		"pairId": pair, "generation": generation, "requestWorkbench": true,
	}})
	if err != nil {
		return peersession.Connected{}, err
	}
	if err := ctx.Err(); err != nil {
		return peersession.Connected{}, err
	}
	var first peersession.Connected
	if protocol.DecodeExact(raw, &first) != nil || first.State.PairID != pair || first.State.Generation != generation ||
		!protocol.ValidNonce(first.State.AttemptID) || first.State.Stage != "ready" || first.State.Error != "" || first.State.RuntimeGeneration != 1 || first.URL == "" {
		return first, errors.New("test.initial_business_scope_mismatch")
	}
	if err := owner.check(peer, completed, first.State); err != nil {
		return first, err
	}
	raw, err = call(ctx, "peer.entry", map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{"pairId": pair, "generation": generation}})
	if err != nil {
		return first, err
	}
	var entry struct {
		ServiceID string            `json:"serviceId"`
		State     peersession.State `json:"state"`
		URL       string            `json:"url"`
	}
	if protocol.DecodeExact(raw, &entry) != nil || entry.ServiceID != f.authority.ServiceID || entry.State != first.State || entry.URL != first.URL {
		return first, errors.New("test.initial_entry_scope_mismatch")
	}
	if err := owner.check(peer, completed, first.State); err != nil {
		return first, err
	}
	return first, ctx.Err()
}

// A ready owner, like D24's initial transport-only owner, is complete and does
// not need an automatic replacement. Never mint a number from a timer or from a
// test counter: the next explicit request succeeds this exact observed owner.
func coreReadySuccessorGeneration(state peersession.State, pair string) (uint64, error) {
	if state.PairID != pair || !protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) ||
		state.Stage != "ready" || state.Error != "" || !protocol.ValidGeneration(state.RuntimeGeneration) || !protocol.ValidGeneration(state.Generation+1) {
		return 0, errors.New("test.ready_generation_invalid")
	}
	return state.Generation + 1, nil
}

// The observed refusal is a completed historical owner, not a promise that auto
// recovery stays idle. Entry linearizes with promotion before peer.state may
// arrive, so either exact refusal below proves that this old owner grants no
// entry. Never infer a new generation, reconnect, or accept another error.
func coreReadRefusedHistoricalEntry(ctx context.Context, call recoveryCoreCall, serviceID, pairID string, completed peersession.Connected) error {
	state := completed.State
	refusal, typed := protocol.Refusal(errors.New(state.Error))
	if !protocol.ValidID(serviceID) || !protocol.ValidID(pairID) || state.PairID != pairID ||
		!protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) ||
		state.Stage != "connected" || !typed || refusal != state.Error || state.RuntimeGeneration != 0 || completed.URL != "" {
		return errors.New("test.historical_workbench_refusal_invalid")
	}
	_, err := call(ctx, "peer.entry", map[string]any{"serviceId": serviceID, "data": map[string]any{
		"pairId": pairID, "generation": state.Generation,
	}})
	if err == nil {
		return errors.New("test.refused_owner_granted_entry")
	}
	if err.Error() != "p2p.not_connected" && err.Error() != "p2p.stale_generation" {
		return fmt.Errorf("test.refused_entry_unexpected: %w", err)
	}
	return ctx.Err()
}

// Workbench refusal retains business intent, so production auto-connect owns
// the next attempt. Observe its exact completed owner instead of racing it with
// a second Connect or accepting stale/busy and retrying. The callback and catalog
// checks are the same ones used by the live initial barrier above.
func coreWaitWorkbenchOutcome(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *fixture, owner *recoveryBootstrapOwner, after uint64, stage, refusal string, runtimeGeneration uint64) (peersession.State, error) {
	for {
		owner.mu.Lock()
		state, changed, err := owner.current, owner.changed, owner.err
		if owner.peer == nil || owner.peer != peer {
			err = errors.New("test.initial_transport_owner_changed")
		}
		owner.mu.Unlock()
		if err != nil {
			return peersession.State{}, err
		}
		if state.Generation > after && state.Stage == stage && state.Error == refusal && state.RuntimeGeneration == runtimeGeneration {
			if err := recoveryReadInitialIntent(ctx, call, f); err != nil {
				return peersession.State{}, err
			}
			owner.mu.Lock()
			err = owner.err
			if owner.peer == nil || owner.peer != peer {
				err = errors.New("test.initial_transport_owner_changed")
			}
			owner.mu.Unlock()
			if err != nil {
				return peersession.State{}, err
			}
			if stage == "ready" {
				if err := owner.check(peer, state, peersession.State{}); err != nil {
					return peersession.State{}, err
				}
			}
			return state, ctx.Err()
		}
		if state.Stage == "failed" || state.Stage == "disconnected" {
			return peersession.State{}, fmt.Errorf("test.workbench_attempt_failed: %+v", state)
		}
		select {
		case <-ctx.Done():
			return peersession.State{}, fmt.Errorf("test.workbench_outcome_not_completed: last=%+v: %w", state, ctx.Err())
		case <-changed:
		}
	}
}
