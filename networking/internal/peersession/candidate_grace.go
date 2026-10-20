package peersession

import (
	"errors"
	"reflect"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// One recovery reservation retains one exact predecessor, never a pair lookup
// that could silently substitute a later owner while this candidate waits.
type candidateGraceOwner struct {
	previous  *session
	ticket    protocol.CandidateTicket
	pin       controlplane.PairIdentity
	owner     *signaling
	active    subscription
	fence     protocol.RegistrationFence
	initiator bool
}

func candidateGraceCommitted(connection *session) bool {
	select {
	case <-connection.committedObserved:
		return true
	default:
		return false
	}
}

func candidateGraceTerminal(previous *session) bool {
	if previous.ctx.Err() != nil {
		return true
	}
	select {
	case <-previous.transport.Done():
		return true
	default:
		return false
	}
}

func candidateGraceMuxDone(connection *session) <-chan struct{} {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.mux == nil {
		return nil
	}
	return connection.mux.Done()
}

// Called after establishment/probe, with the early decision observer and lease
// worker still alive. No consumable transport or control notification is read.
func (manager *Manager) awaitCandidateGrace(connection *session) error {
	manager.mu.Lock()
	if connection.promoted || connection.commitDispatched || candidateGraceCommitted(connection) {
		manager.mu.Unlock()
		return nil
	}
	previous := connection.predecessor
	if !connection.predecessorWasSuspended || previous == nil || previous.remoteReplaced || (connection.requestWorkbench && connectionState(previous).RuntimeGeneration == 0) {
		manager.mu.Unlock()
		return nil
	}
	err := manager.captureCandidateGraceLocked(connection)
	manager.mu.Unlock()
	if err != nil {
		return err
	}
	deadline := time.NewTimer(time.Until(time.Unix(connection.graceOwner.ticket.PrepareDeadline, 0)))
	defer deadline.Stop()
	expired := false
	for {
		manager.mu.Lock()
		wait, err := manager.candidateGracePendingLocked(connection)
		if wait && expired {
			wait, err = false, errors.New("p2p.candidate_expired")
		}
		manager.mu.Unlock()
		if err != nil || !wait {
			return err
		}
		select {
		case <-connection.ctx.Done():
		case <-connection.transport.Done():
		case <-candidateGraceMuxDone(connection):
		case <-connection.cancelRequested:
		case <-connection.committedObserved:
		case <-previous.ctx.Done():
		case <-previous.transport.Done():
		case <-deadline.C:
			expired = true
		}
	}
}

// Caller holds manager.mu, as at the final commit-dispatch barrier.
func (manager *Manager) captureCandidateGraceLocked(connection *session) error {
	if connection.ticket == nil || connection.predecessor.transport == nil {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	owner := manager.signals
	if owner == nil {
		return errors.New("p2p.registration_stale")
	}
	active, ok := owner.current()
	if !ok {
		return errors.New("p2p.registration_stale")
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return errors.New("p2p.protocol_mismatch")
	}
	fence, err := control.Registration()
	if err != nil {
		return err
	}
	pin := manager.pins[connection.PairID]
	pin.Initiator.PublicKey = append([]byte(nil), pin.Initiator.PublicKey...)
	pin.Target.PublicKey = append([]byte(nil), pin.Target.PublicKey...)
	connection.graceOwner = &candidateGraceOwner{previous: connection.predecessor, ticket: *connection.ticket,
		pin: pin, owner: owner, active: active, fence: fence,
		initiator: connection.lease.FromDeviceID == manager.config.Device.DeviceID}
	return manager.validateCandidateGraceLocked(connection)
}

func (manager *Manager) validateCandidateGraceLocked(connection *session) error {
	gate := connection.graceOwner
	if gate == nil || connection.ticket == nil || *connection.ticket != gate.ticket || connection.predecessor != gate.previous || manager.signals != gate.owner || manager.closed || !manager.candidatesActive || !manager.ownsCandidateLocked(connection, gate.initiator) {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	lease, old := gate.ticket.Lease, gate.previous
	if old.ticket == nil || old.ticket.FromCoreInstanceID != gate.ticket.FromCoreInstanceID || old.ticket.ToCoreInstanceID != gate.ticket.ToCoreInstanceID {
		return errors.New("p2p.core_replaced")
	}
	primary, local, core := manager.inbound[connection.PairID], lease.ToDeviceID, gate.ticket.ToCoreInstanceID
	if gate.initiator {
		primary, local, core = manager.sessions[connection.PairID], lease.FromDeviceID, gate.ticket.FromCoreInstanceID
	}
	if local != manager.config.Device.DeviceID || core != manager.config.CoreInstanceID || lease != connection.lease || gate.ticket.PreviousAttemptID != old.lease.AttemptID || gate.ticket.PreviousGeneration != old.lease.Generation || old.lease.UserID != lease.UserID || old.lease.NetworkID != lease.NetworkID || old.lease.FromDeviceID != lease.FromDeviceID || old.lease.ToDeviceID != lease.ToDeviceID || !old.promoted || old.remoteReplaced || (primary != old && (primary != nil || !candidateGraceTerminal(old))) {
		return errors.New("p2p.stale_generation")
	}
	if manager.accountUserID != lease.UserID || manager.client.Account() != lease.UserID || !reflect.DeepEqual(manager.pins[connection.PairID], gate.pin) || gate.pin.Pair.State != "active" || gate.pin.Pair.NetworkID != lease.NetworkID {
		return errors.New("p2p.pair_unauthorized")
	}
	from, target := gate.pin.Initiator, gate.pin.Target
	if from.DeviceID != lease.FromDeviceID {
		from, target = target, from
	}
	if from.DeviceID != lease.FromDeviceID || target.DeviceID != lease.ToDeviceID || from.UserID != lease.UserID || target.UserID != lease.UserID {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	active, ok := gate.owner.current()
	if !ok || active != gate.active {
		return errors.New("p2p.registration_stale")
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return errors.New("p2p.protocol_mismatch")
	}
	fence, err := control.Registration()
	if err != nil || fence != gate.fence || fence.ServerEpoch != gate.ticket.ServerEpoch || fence.CoreInstanceID != core {
		return errors.New("p2p.registration_stale")
	}
	if gate.ticket.PrepareDeadline <= time.Now().Unix() {
		return errors.New("p2p.candidate_expired")
	}
	return nil
}

func (manager *Manager) candidateGracePendingLocked(connection *session) (bool, error) {
	if connection.promoted || connection.commitDispatched || candidateGraceCommitted(connection) {
		return false, nil // A durable decision cannot be undone by local recovery.
	}
	if err := manager.validateCandidateGraceLocked(connection); err != nil {
		return false, err
	}
	if err := connection.ctx.Err(); err != nil {
		return false, err
	}
	select {
	case <-connection.transport.Done():
		return false, errors.New("p2p.direct_closed")
	default:
	}
	select {
	case <-candidateGraceMuxDone(connection):
		return false, errors.New("p2p.not_connected")
	default:
	}
	if connection.cancellationRequested() {
		return false, errors.New("p2p.connection_cancelled")
	}
	old := connection.graceOwner.previous
	if candidateGraceTerminal(old) {
		return false, nil
	}
	if old.transport.LiveState().Ready {
		connection.requestCancel()
		return false, errors.New("p2p.connection_cancelled")
	}
	return true, nil
}

func (manager *Manager) candidateGraceCommitLocked(connection *session) error {
	if connection.graceOwner == nil || candidateGraceCommitted(connection) {
		return nil
	}
	wait, err := manager.candidateGracePendingLocked(connection)
	if err != nil {
		return err
	}
	if wait {
		return errors.New("p2p.connection_cancelled")
	}
	return nil
}

func (manager *Manager) candidateGraceReady(connection *session) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.candidateGraceCommitLocked(connection)
}
