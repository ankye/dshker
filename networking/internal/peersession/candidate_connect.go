package peersession

import (
	"context"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func (manager *Manager) connectCandidate(ctx context.Context, pairID string, generation uint64, requestWorkbench, resume bool) (Connected, error) {
	if ctx.Err() != nil {
		return Connected{}, ctx.Err()
	}
	connection, err := manager.reserveCandidate(pairID, generation, requestWorkbench, resume)
	if err != nil {
		return Connected{}, err
	}
	go manager.sourceCandidate(connection)
	return waitCandidate(ctx, connection)
}

func (manager *Manager) reserveCandidate(pairID string, generation uint64, requested, resume bool) (*session, error) {
	if !protocol.ValidID(pairID) || !protocol.ValidGeneration(generation) {
		return nil, errors.New("p2p.invalid_request")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return nil, errors.New("p2p.helper_unavailable")
	}
	if !protocol.ValidNonce(manager.config.CoreInstanceID) {
		return nil, errors.New("p2p.protocol_mismatch")
	}
	if !manager.candidatesActive {
		return nil, errors.New("p2p.candidate_unsupported")
	}
	pin, ok := manager.pins[pairID]
	if !ok {
		return nil, errors.New("p2p.pair_unauthorized")
	}
	target, err := manager.targetDevice(pin)
	if err != nil {
		return nil, err
	}
	if manager.candidates[pairID] != nil {
		return nil, errors.New("p2p.connection_busy")
	}
	if generation <= manager.generations[pairID] {
		return nil, errors.New("p2p.stale_generation")
	}
	if manager.generations == nil {
		manager.generations = make(map[string]uint64)
	}
	if manager.candidates == nil {
		manager.candidates = make(map[string]*session)
	}
	if manager.workbenches == nil {
		manager.workbenches = make(map[string]bool)
	}
	manager.generations[pairID] = generation
	if requested {
		manager.workbenches[pairID] = true
	}
	connection := newSession(manager.ctx)
	connection.PairID, connection.requestWorkbench = pairID, manager.workbenches[pairID]
	connection.resumeWorkbench = connection.requestWorkbench && resume
	connection.predecessor = manager.sessions[pairID]
	if connection.predecessor != nil && connection.predecessor.transport != nil {
		live := connection.predecessor.transport.LiveState()
		connection.predecessorWindow = live.Window
		connection.predecessorWasSuspended = live.Suspended || connection.predecessor.remoteReplaced || connectionState(connection.predecessor).Stage == "suspended"
		// Reconnect is an admitted background recovery request. The primary can
		// recover after the engine's Stage read but before this reservation; do
		// not lose that intent merely because both live/projection are ready now.
		if resume && !requested && !connection.predecessor.remoteReplaced && connectionState(connection.predecessor).RuntimeGeneration > 0 {
			connection.predecessorWasSuspended = true
		}
	}
	connection.prepare = &protocol.PrepareCandidate{AttemptID: protocol.NewNonce(), UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: target, Generation: generation}
	manager.candidates[pairID] = connection
	return connection, nil
}

func (manager *Manager) sourceCandidate(connection *session) {
	err := manager.prepareCandidate(connection)
	if err == nil && (connection.cancellationRequested() || connection.ctx.Err() != nil) {
		err = manager.resolveCandidateCancellation(connection)
	}
	if err == nil {
		err = manager.createCandidateTransport(connection)
	}
	if err != nil {
		manager.failUnstartedCandidate(connection, err)
		return
	}
	go manager.runCandidate(connection, true)
	ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	defer cancel()
	record, logged := manager.captureCandidateGather(connection, "offer")
	if logged {
		writeCandidateControlDiagnostic(record)
	}
	offer, err := connection.transport.Offer(ctx)
	if logged {
		disposition := "gathered"
		if err != nil {
			disposition = "failed"
		}
		if result, ok := candidateControlResult(record, disposition, err); ok {
			writeCandidateControlDiagnostic(result)
		}
	}
	if err == nil {
		err = manager.sendCandidate(ctx, connection, offer)
	}
	if err != nil {
		connection.stop("candidate_offer_failed", err)
	}
}

func (manager *Manager) prepareCandidate(connection *session) error {
	fence, err := manager.registration()
	if err != nil {
		return err
	}
	request := *connection.prepare
	state, err := manager.client.LinkState(connection.ctx, protocol.LinkStateRequest{Registration: fence, UserID: request.UserID, NetworkID: request.NetworkID, PairID: request.PairID})
	if err != nil {
		return err
	}
	if state.ServerEpoch != fence.ServerEpoch || !validActive(state.CurrentActiveAttemptID, state.CurrentActiveGeneration) || !protocol.ValidNonce(state.PeerCoreInstanceID) || !protocol.ValidControlCapabilities(state.PeerCapabilities) || !protocol.HasCapability(state.PeerCapabilities, protocol.CapabilityCandidate) {
		return errors.New("p2p.protocol_mismatch")
	}
	request.PreviousAttemptID, request.PreviousGeneration = state.CurrentActiveAttemptID, state.CurrentActiveGeneration
	request.ToCoreInstanceID = state.PeerCoreInstanceID
	manager.mu.Lock()
	connection.prepare = &request
	manager.mu.Unlock()
	// Once dispatched, the slot remains occupied until this exact id is resolved.
	// A lost prepare reply is resolved by state-by-id or an identical replay.
	unknown := false
	for manager.ctx.Err() == nil {
		if manager.client.Account() != request.UserID {
			return errors.New("p2p.user_unauthorized")
		}
		request.Registration, err = manager.registration()
		if err == nil {
			var ticket protocol.CandidateTicket
			ticket, err = manager.client.PrepareCandidate(manager.ctx, request)
			if err == nil {
				err = manager.installCandidateTicket(connection, ticket)
				if err == nil && !unknown {
					return nil
				}
			}
		}
		unknown = true
		state, readErr := manager.readPreparedCandidate(connection, request)
		if readErr == nil {
			readErr = manager.installCandidateTicket(connection, state.Ticket)
			if readErr == nil {
				readErr = manager.validateCandidateState(connection, state)
			}
			if readErr == nil {
				if state.Decision.Status == "cancelled" || state.Decision.Status == "expired" {
					return errors.New(state.Decision.Reason)
				}
				return nil
			}
		}
		// These are authoritative admission refusals, not decoder/transport
		// failures. A missing record or revoked scope confirms there is no live
		// candidate left to resolve. In particular, cancelling the caller is not
		// itself evidence of non-admission.
		if refusedPrepare(err) && prepareDefinitelyAbsent(readErr) {
			return err
		}
		// A malformed or lost reply may follow durable prepare. Keep this id
		// reserved and replay its immutable request, even after RPC cancellation.
		if !manager.preparePause(connection) {
			return manager.ctx.Err()
		}
	}
	return manager.ctx.Err()
}

func refusedPrepare(err error) bool {
	if err == nil {
		return false
	}
	switch err.Error() {
	case "p2p.user_unauthorized", "p2p.binding_unauthorized", "p2p.network_unauthorized", "p2p.pair_revoked", "p2p.pair_unauthorized", "p2p.peer_offline", "p2p.core_replaced", "p2p.account_changed", "p2p.active_changed", "p2p.candidate_conflict", "p2p.connection_busy", "p2p.stale_generation", "p2p.candidate_unsupported", "p2p.invalid_request":
		return true
	default:
		return false
	}
}

func prepareDefinitelyAbsent(err error) bool {
	if err == nil {
		return false
	}
	switch {
	case err.Error() == "p2p.attempt_not_found", candidateAuthorityEnded(err):
		return true
	default:
		// Registration/core changes and peer liveness are not non-admission
		// proofs. A known id may still have a durable pending decision.
		return false
	}
}

func uncertainControlError(err error) bool {
	if err == nil {
		return false
	}
	switch err.Error() {
	case "p2p.rate_limited", "p2p.server_unavailable", "p2p.signalling_not_ready", "p2p.registration_stale", "p2p.subscription_superseded", "p2p.signal_superseded":
		return true
	default:
		return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	}
}

func (manager *Manager) readPreparedCandidate(connection *session, request protocol.PrepareCandidate) (protocol.CandidateState, error) {
	fence, err := manager.registration()
	if err != nil {
		return protocol.CandidateState{}, err
	}
	return manager.client.CandidateState(manager.ctx, protocol.CandidateStateRequest{Registration: fence, AttemptID: request.AttemptID, UserID: request.UserID, NetworkID: request.NetworkID, PairID: request.PairID})
}

func (manager *Manager) preparePause(connection *session) bool {
	select {
	case <-manager.ctx.Done():
		return false
	case <-connection.changed:
		return true
	case <-time.After(250 * time.Millisecond):
		return true
	}
}

func (manager *Manager) installCandidateTicket(connection *session, ticket protocol.CandidateTicket) error {
	if err := ticket.Verify(manager.config.Authority.PublicKey); err != nil {
		return err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	request := connection.prepare
	lease := ticket.Lease
	_, retiring := manager.retiring[connection]
	if request == nil || lease.AttemptID != request.AttemptID || lease.UserID != request.UserID || lease.NetworkID != request.NetworkID || lease.PairID != request.PairID || lease.Generation != request.Generation || lease.FromDeviceID != manager.config.Device.DeviceID || ticket.FromCoreInstanceID != manager.config.CoreInstanceID || ticket.ToCoreInstanceID != request.ToCoreInstanceID || ticket.PreviousAttemptID != request.PreviousAttemptID || ticket.PreviousGeneration != request.PreviousGeneration || (manager.candidates[connection.PairID] != connection && !retiring) {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	connection.ticket, connection.lease = &ticket, lease
	return nil
}

func (manager *Manager) createCandidateTransport(connection *session) error {
	creds, err := manager.candidateTurnEndpoints(connection)
	if err != nil {
		return err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed || connection.ctx.Err() != nil || !manager.ownsCandidateLocked(connection, connection.lease.FromDeviceID == manager.config.Device.DeviceID) {
		return errors.New("p2p.connection_cancelled")
	}
	pin, ok := manager.pins[connection.PairID]
	if !ok || connection.ticket == nil {
		return errors.New("p2p.pair_unauthorized")
	}
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	lease := connection.ticket.Lease
	options := peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: manager.config.Endpoints.STUNAddress, LocalDeviceID: local.DeviceID, PeerDeviceID: remote.DeviceID, PrivateKey: manager.config.PrivateKey, PeerKey: remote.PublicKey, ServiceKey: manager.config.Authority.PublicKey, Scope: protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}, Revision: lease.Revision, Lease: lease, Ticket: connection.ticket}
	if len(creds.URLs) > 0 {
		options.TurnURL, options.TurnUsername, options.TurnCredential = creds.URLs[0], creds.Username, creds.Credential
	}
	transport, err := peer.NewTransport(connection.ctx, options)
	if err != nil {
		return err
	}
	connection.transport = transport
	connection.signalDone = make(chan struct{})
	go manager.forwardCandidateSignals(connection)
	return nil
}

func (manager *Manager) candidateTurnEndpoints(connection *session) (controlplane.TurnCredentials, error) {
	manager.mu.Lock()
	ticket := connection.ticket
	manager.mu.Unlock()
	if ticket == nil {
		return controlplane.TurnCredentials{}, errors.New("p2p.candidate_scope_mismatch")
	}
	// No renewal or retry may extend these original admission bounds.
	deadline := ticket.PrepareDeadline
	if ticket.Lease.ExpiresAt < deadline {
		deadline = ticket.Lease.ExpiresAt
	}
	ctx, cancel := context.WithDeadline(connection.ctx, time.Unix(deadline, 0))
	defer cancel()
	for {
		if connection.cancellationRequested() {
			return controlplane.TurnCredentials{}, manager.resolveCandidateCancellation(connection)
		}
		if ctx.Err() != nil {
			if connection.ctx.Err() != nil {
				return controlplane.TurnCredentials{}, connection.ctx.Err()
			}
			return controlplane.TurnCredentials{}, errors.New("p2p.lease_expired")
		}
		creds, err := manager.turnEndpoints(ctx)
		if err == nil {
			return creds, nil
		}
		if err.Error() == "p2p.relay_unconfigured" {
			// This server explicitly advertises its STUN-only deployment mode.
			return controlplane.TurnCredentials{}, nil
		}
		if !uncertainControlError(err) {
			return controlplane.TurnCredentials{}, err
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
		case <-connection.cancelRequested:
		case <-connection.changed:
		case <-timer.C:
		}
		timer.Stop()
	}
}

// One bounded complete-SDP queue belongs to an already admitted ticket. It lets
// the subscription consume revocation while TURN admission is waiting, without
// inventing candidates from unknown offers or creating unjoined signal workers.
func (manager *Manager) forwardCandidateSignals(connection *session) {
	defer close(connection.signalDone)
	for {
		select {
		case <-connection.ctx.Done():
			return
		case signal := <-connection.signalInbox:
			manager.receiveCandidateSignal(connection, signal)
		}
	}
}

func (manager *Manager) failUnstartedCandidate(connection *session, err error) {
	if connection.ticket != nil {
		manager.endCandidate(connection, "failed")
	}
	connection.cancel()
	if connection.signalDone != nil {
		<-connection.signalDone
	}
	manager.finish(connection.PairID, connection)
	connection.complete(Connected{}, err)
	manager.wake(connection.PairID)
}

func candidatePause(connection *session) bool {
	select {
	case <-connection.ctx.Done():
		return false
	case <-connection.changed:
		return true
	case <-time.After(250 * time.Millisecond):
		return true
	}
}
