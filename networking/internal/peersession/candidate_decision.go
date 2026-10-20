package peersession

import (
	"context"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func (manager *Manager) readyAndResolveCandidate(connection *session, initiator bool) error {
	initial, err := manager.readyCandidateReceipt(connection)
	if err == nil && !manager.isPromoted(connection) {
		err = manager.resolveCandidateReceipt(connection, initiator, initial)
	}
	return err
}

func (manager *Manager) readyCandidate(connection *session) error {
	_, err := manager.readyCandidateReceipt(connection)
	return err
}

type candidateReadyReceipt struct {
	state  protocol.CandidateState
	action protocol.CandidateAction
	owner  *signaling
	active subscription
}

func (manager *Manager) readyCandidateReceipt(connection *session) (*candidateReadyReceipt, error) {
	for connection.ctx.Err() == nil {
		if connection.cancellationRequested() {
			return nil, manager.resolveCandidateCancellation(connection)
		}
		manager.mu.Lock()
		owner := manager.signals
		manager.mu.Unlock()
		var active subscription
		if owner != nil {
			active, _ = owner.current()
		}
		action, err := manager.candidateAction(connection)
		if err == nil {
			var state protocol.CandidateState
			connection.controlMu.Lock()
			state, err = manager.client.ReadyCandidate(connection.ctx, action)
			connection.controlMu.Unlock()
			if err == nil {
				err = manager.validateCandidateState(connection, state)
				if err == nil {
					if terminal := candidateDecisionError(state); terminal != nil {
						return nil, terminal
					}
					if candidateOwnReady(connection, state, manager.config.Device.DeviceID) {
						if state.Decision.Status == "pending" {
							return &candidateReadyReceipt{state: state, action: action, owner: owner, active: active}, nil
						}
						return nil, nil
					}
				}
			}
		}
		if candidateAuthorityEnded(err) {
			return nil, err
		}
		// The Ready may already have taken effect even if its HTTP reply could
		// not be decoded. Only own-readiness or a durable decision advances us.
		state, readErr := manager.candidateState(connection)
		if readErr == nil {
			if terminal := candidateDecisionError(state); terminal != nil {
				return nil, terminal
			}
			if candidateOwnReady(connection, state, manager.config.Device.DeviceID) {
				return nil, nil
			}
		} else if candidateAuthorityEnded(readErr) {
			return nil, readErr
		}
		if !candidatePause(connection) {
			break
		}
	}
	return nil, connection.ctx.Err()
}

// This is a one-use same-call pending result, never stored on a session. Any
// changed operation/registration owner forces the original fresh State path.
func (manager *Manager) currentReadyReceipt(connection *session, initiator bool, receipt *candidateReadyReceipt) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if receipt == nil || receipt.state.Decision.Status != "pending" || connection.ticket == nil || receipt.action.Ticket != *connection.ticket ||
		manager.client.Account() != connection.lease.UserID || manager.accountUserID != connection.lease.UserID || !manager.ownsCandidateLocked(connection, initiator) || manager.signals != receipt.owner || receipt.owner == nil {
		return false
	}
	if _, pinned := manager.pins[connection.PairID]; !pinned {
		return false
	}
	core := connection.ticket.ToCoreInstanceID
	local := connection.lease.ToDeviceID
	if initiator {
		core = connection.ticket.FromCoreInstanceID
		local = connection.lease.FromDeviceID
	}
	active, ok := receipt.owner.current()
	if !ok || active != receipt.active {
		return false
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return false
	}
	fence, err := control.Registration()
	return err == nil && fence == receipt.action.Registration && fence.ServerEpoch == connection.ticket.ServerEpoch && fence.CoreInstanceID == manager.config.CoreInstanceID && core == manager.config.CoreInstanceID && local == manager.config.Device.DeviceID && manager.validateCandidateReceipt(*connection.ticket, receipt.state) == nil
}

func candidateOwnReady(connection *session, state protocol.CandidateState, deviceID string) bool {
	if state.Decision.Status == "committed" {
		return true
	}
	if connection.lease.ToDeviceID == deviceID {
		return state.ToReady
	}
	return state.FromReady
}

func candidateDecisionError(state protocol.CandidateState) error {
	if state.Decision.Status == "cancelled" || state.Decision.Status == "expired" {
		return errors.New(state.Decision.Reason)
	}
	return nil
}

// A dispatched commit belongs to the manager, not the requesting RPC. Only the
// durable decision may release its resources or grant local promotion.
func (manager *Manager) resolveCandidate(connection *session, initiator bool) error {
	return manager.resolveCandidateReceipt(connection, initiator, nil)
}

func (manager *Manager) resolveCandidateReceipt(connection *session, initiator bool, initial *candidateReadyReceipt) error {
	for connection.ctx.Err() == nil {
		manager.mu.Lock()
		dispatched := connection.commitDispatched
		manager.mu.Unlock()
		if connection.cancellationRequested() && !dispatched {
			return manager.resolveCandidateCancellation(connection)
		}
		var state protocol.CandidateState
		var err error
		if initial != nil && manager.currentReadyReceipt(connection, initiator, initial) {
			state = initial.state
		} else {
			state, err = manager.candidateState(connection)
		}
		initial = nil
		if err != nil {
			if !dispatched && !uncertainControlError(err) {
				return manager.resolveCandidateCancellation(connection)
			}
		} else {
			if err := candidateDecisionError(state); err != nil {
				return err
			}
			if state.Decision.Status == "committed" {
				return manager.promoteCandidate(connection, state, initiator)
			}
			if initiator && state.FromReady && state.ToReady {
				state, err = manager.commitCandidate(connection)
				if err != nil && err.Error() == "p2p.connection_cancelled" && !dispatched {
					return manager.resolveCandidateCancellation(connection)
				}
				if err == nil && state.Decision.Status == "committed" {
					return manager.promoteCandidate(connection, state, true)
				}
				if err == nil {
					err = candidateDecisionError(state)
				}
				// Any dispatched outcome is resolved by the durable decision, even
				// when the HTTP reply was a refusal or could not be decoded.
			}
		}
		if !candidatePause(connection) {
			break
		}
	}
	return connection.ctx.Err()
}

func (manager *Manager) commitCandidate(connection *session) (protocol.CandidateState, error) {
	action, err := manager.candidateAction(connection)
	if err != nil {
		return protocol.CandidateState{}, err
	}
	manager.mu.Lock()
	if !manager.ownsCandidateLocked(connection, true) || connection.ctx.Err() != nil || !connection.transport.LiveState().Ready {
		manager.mu.Unlock()
		return protocol.CandidateState{}, errors.New("p2p.connection_cancelled")
	}
	// Recovery may win until commit dispatch. After this point a late recovery
	// cannot decide that the remote CAS did not happen.
	if !connection.commitDispatched && (connection.cancellationRequested() || manager.predecessorRecoveredLocked(connection)) {
		manager.mu.Unlock()
		connection.requestCancel()
		return protocol.CandidateState{}, errors.New("p2p.connection_cancelled")
	}
	connection.commitDispatched = true
	manager.mu.Unlock()
	ctx, cancel := context.WithTimeout(manager.ctx, 10*time.Second)
	defer cancel()
	connection.controlMu.Lock()
	state, err := manager.client.CommitCandidate(ctx, action)
	connection.controlMu.Unlock()
	if err == nil {
		err = manager.validateCandidateState(connection, state)
	}
	return state, err
}

func (manager *Manager) predecessorRecoveredLocked(connection *session) bool {
	old := connection.predecessor
	if !connection.predecessorWasSuspended || old == nil || old.transport == nil || old.remoteReplaced || !old.transport.LiveState().Ready {
		return false
	}
	return !connection.requestWorkbench || connectionState(old).RuntimeGeneration > 0
}

func (manager *Manager) resolveCandidateCancellation(connection *session) error {
	for manager.ctx.Err() == nil {
		if manager.client.Account() != connection.lease.UserID {
			return errors.New("p2p.user_unauthorized")
		}
		action, err := manager.candidateAction(connection)
		if err == nil {
			var state protocol.CandidateState
			connection.controlMu.Lock()
			state, err = manager.client.CancelCandidate(manager.ctx, action)
			connection.controlMu.Unlock()
			if candidateAuthorityEnded(err) {
				connection.noteStop("candidate_authorization_ended", err)
				return err
			}
			if err == nil {
				if manager.validateCandidateState(connection, state) == nil {
					if done, result := manager.cancellationDecision(connection, state); done {
						return result
					}
				}
			}
		}
		state, readErr := manager.candidateState(connection)
		if readErr == nil {
			if done, result := manager.cancellationDecision(connection, state); done {
				return result
			}
		} else if candidateAuthorityEnded(readErr) {
			connection.noteStop("candidate_authorization_ended", readErr)
			return readErr
		}
		if !manager.preparePause(connection) {
			break
		}
	}
	return manager.ctx.Err()
}

func (manager *Manager) resolveCandidateCancellationAfterObserver(connection *session, unknownCancel bool) error {
	if unknownCancel {
		// Stopping the observer did not prove its Cancel failed. Resolve the
		// exact dispatched mutation before any idempotent replay or slot release.
		state, err := manager.candidateState(connection)
		if err == nil {
			if done, result := manager.cancellationDecision(connection, state); done {
				return result
			}
		} else if candidateAuthorityEnded(err) {
			connection.noteStop("candidate_authorization_ended", err)
			return err
		}
	}
	return manager.resolveCandidateCancellation(connection)
}

func (manager *Manager) cancellationDecision(connection *session, state protocol.CandidateState) (bool, error) {
	if state.Decision.Status == "committed" {
		return true, manager.promoteCandidate(connection, state, connection.lease.FromDeviceID == manager.config.Device.DeviceID)
	}
	if terminal := candidateDecisionError(state); terminal != nil {
		return true, terminal
	}
	return false, nil
}

func (manager *Manager) promoteCandidate(connection *session, state protocol.CandidateState, initiator bool) error {
	return manager.promoteCandidateFrom(connection, state, initiator, nil)
}

type targetPromotionAdmission struct {
	owner      *signaling
	active     subscription
	fence      protocol.RegistrationFence
	queued     *inboundAdmission
	retirement *targetPromotionRetirement
}

// A caller allocates this zero result for one promotion call. Only the exact
// committed admission barrier writes it; cleanup collections cannot erase it.
// It is not a retained State/Ready grant and cannot authorize another job.
type targetPromotionRetirement struct {
	previous *session
	queued   *inboundAdmission
}

// A target's ordered committed event must finish local promotion before the
// receiver consumes the next prepared event. This admission is rechecked inside
// the slot barrier, not just when the receiver first observes the event.
func (manager *Manager) promoteCandidateFrom(connection *session, state protocol.CandidateState, initiator bool, admission *targetPromotionAdmission) error {
	if state.Decision.Status != "committed" || !state.FromReady || !state.ToReady {
		return errors.New("p2p.invalid_server_response")
	}
	lease := connection.lease
	if state.CurrentActiveAttemptID != lease.AttemptID || state.CurrentActiveGeneration != lease.Generation {
		return errors.New("p2p.stale_generation")
	}
	if connection.ticket == nil {
		return errors.New("p2p.not_connected")
	}
	if err := manager.validateCandidateReceipt(*connection.ticket, state); err != nil {
		return err
	}
	manager.mu.Lock()
	unlock := manager.mu.Unlock
	if connection.transport == nil && (admission == nil || admission.queued == nil) {
		unlock()
		return errors.New("p2p.not_connected")
	}
	if admission != nil {
		if initiator || manager.closed || manager.signals != admission.owner || manager.accountUserID != lease.UserID || manager.client.Account() != lease.UserID ||
			lease.ToDeviceID != manager.config.Device.DeviceID || connection.ticket.ToCoreInstanceID != manager.config.CoreInstanceID ||
			state.Decision.Status != "committed" || !state.FromReady || !state.ToReady {
			unlock()
			return errors.New("p2p.candidate_scope_mismatch")
		}
		owner := admission.owner
		owner.mu.Lock()
		unlock = func() { owner.mu.Unlock(); manager.mu.Unlock() }
		control, ok := owner.active.(controlSubscription)
		if !ok || owner.closed || owner.down || owner.active != admission.active {
			unlock()
			return errors.New("p2p.registration_stale")
		}
		select {
		case <-owner.active.Done():
			unlock()
			return errors.New("p2p.registration_stale")
		default:
		}
		fence, err := control.Registration()
		if err != nil || fence != admission.fence || fence.ServerEpoch != connection.ticket.ServerEpoch || fence.CoreInstanceID != manager.config.CoreInstanceID {
			unlock()
			return errors.New("p2p.registration_stale")
		}
		if admission.queued != nil {
			if admission.queued.previous != connection || admission.queued.connection.PairID != connection.PairID {
				unlock()
				return errors.New("p2p.candidate_scope_mismatch")
			}
			if err := manager.checkInboundAdmissionLocked(admission.queued); err != nil {
				unlock()
				return err
			}
		}
	}
	if connection.promoted {
		owned := manager.sessions[connection.PairID] == connection || manager.inbound[connection.PairID] == connection
		unlock()
		if owned {
			return state.LatestLease.VerifyCandidate(manager.config.Authority.PublicKey, *connection.ticket, time.Now())
		}
		return errors.New("p2p.stale_generation")
	}
	if !manager.ownsCandidateLocked(connection, initiator) {
		unlock()
		return errors.New("p2p.connection_cancelled")
	}
	if _, pinned := manager.pins[connection.PairID]; !pinned {
		unlock()
		return errors.New("p2p.pair_unauthorized")
	}
	connection.mu.Lock()
	mux, endpoint, probeGateway := connection.mux, connection.stagedEndpoint, connection.stagedGateway
	connection.mu.Unlock()
	// A replayed Prepared may have been pending when it was queued remotely,
	// then committed before this local owner rebuilt its carrier. Only the
	// exact queued State owner above may retire that unbuilt historical slot.
	// A staged mux whose transport is temporarily !Ready is not startup death.
	unrebuilt := admission != nil && admission.queued != nil && (connection.transport == nil || mux == nil)
	dead := connection.ctx.Err() != nil || unrebuilt
	if connection.transport != nil {
		select {
		case <-connection.transport.Done():
			dead = true
		default:
		}
	}
	if mux != nil {
		select {
		case <-mux.Done():
			dead = true
		default:
		}
	}
	if admission != nil && dead {
		// The durable decision cannot be rolled back, but a dead local carrier
		// must neither claim ready nor swallow the next ordered prepared event.
		// This is carrier retirement, not scope revocation: End(failed) must
		// retain an already admitted successor's exact predecessor CAS.
		if manager.retiring == nil {
			manager.retiring = make(map[*session]struct{})
		}
		manager.retiring[connection] = struct{}{}
		delete(manager.inboundCandidates, connection.PairID)
		previous, previousEndpoint, previousMux := manager.retireCommittedPredecessorLocked(connection)
		if admission.queued != nil && admission.retirement != nil {
			*admission.retirement = targetPromotionRetirement{previous: connection, queued: admission.queued}
		}
		connection.stop("committed_carrier_unavailable", errors.New("p2p.not_connected"))
		result := connectionState(connection)
		result.Stage, result.Error = "failed", "p2p.not_connected"
		unlock()
		if previous != nil {
			previous.stop("active_replaced", errors.New("p2p.stale_generation"))
			if previousEndpoint != nil {
				previousEndpoint.Detach(previousMux)
			}
			if previousMux != nil {
				previousMux.Close()
			}
		}
		connection.complete(Connected{State: result}, errors.New("p2p.not_connected"))
		return errors.New("p2p.not_connected")
	}
	// A signed committed receipt still retires its dead carrier after its
	// snapshot lease expires. Only live promotion needs a current lease grant.
	if err := state.LatestLease.VerifyCandidate(manager.config.Authority.PublicKey, *connection.ticket, time.Now()); err != nil {
		unlock()
		return err
	}
	if dead || !connection.transport.LiveState().Ready {
		unlock()
		return errors.New("p2p.connection_cancelled")
	}
	if mux == nil {
		unlock()
		return errors.New("p2p.not_connected")
	}
	select {
	case <-mux.Done():
		unlock()
		return errors.New("p2p.not_connected")
	default:
	}
	if err := connection.transport.UpdateLease(state.LatestLease); err != nil {
		unlock()
		return err
	}
	var binding runtimebridge.Binding
	var err error
	if endpoint != nil {
		binding, err = endpoint.Binding()
	}
	if err != nil {
		unlock()
		return err
	}
	slots, candidates, endpoints := manager.sessions, manager.candidates, manager.endpoints
	if !initiator {
		slots, candidates, endpoints = manager.inbound, manager.inboundCandidates, manager.inboundEndpoints
	}
	old, oldEndpoint := slots[connection.PairID], endpoints[connection.PairID]
	if initiator && endpoint != nil && oldEndpoint != nil {
		if err := oldEndpoint.Replace(mux, binding); err != nil {
			unlock()
			return err
		}
		endpoint = oldEndpoint
	}
	if endpoints == nil {
		endpoints = make(map[string]*runtimebridge.Endpoint)
		if initiator {
			manager.endpoints = endpoints
		} else {
			manager.inboundEndpoints = endpoints
		}
	}
	if slots == nil {
		slots = make(map[string]*session)
		if initiator {
			manager.sessions = slots
		} else {
			manager.inbound = slots
		}
	}
	if endpoint != nil {
		endpoints[connection.PairID] = endpoint
	}
	slots[connection.PairID] = connection
	delete(candidates, connection.PairID)
	connection.promoted = true
	connection.mu.Lock()
	connection.endpoint = endpoint
	result := connection.result
	result.State.RuntimeGeneration, result.State.Error = binding.Generation, ""
	if endpoint != nil {
		result.State.Stage, result.URL = "ready", endpoint.LocalURL()
	} else {
		result.State.Stage = "connected"
	}
	connection.result, connection.err = result, nil
	connection.mu.Unlock()
	unlock()
	connection.complete(result, nil)
	if initiator {
		manager.emitOwned(connection, result.State)
	}
	if probeGateway != nil && endpoint != connection.stagedEndpoint {
		connection.stagedEndpoint.Close()
	}
	if old != nil && old != connection {
		old.stop("candidate_promoted", nil)
	}
	if !initiator && oldEndpoint != nil && oldEndpoint != endpoint {
		oldEndpoint.Close()
	}
	return nil
}

// A known committed successor cannot restore its predecessor's old authority
// even when its own local carrier has already died. Keep the old endpoint's
// stable listener, but stop only the exact predecessor named by this receipt.
func (manager *Manager) retireCommittedPredecessorLocked(connection *session) (*session, *runtimebridge.Endpoint, *peer.Mux) {
	ticket := connection.ticket
	previous := manager.inbound[connection.PairID]
	if previous == nil || ticket == nil || previous.lease.AttemptID != ticket.PreviousAttemptID || previous.lease.Generation != ticket.PreviousGeneration ||
		previous.lease.UserID != connection.lease.UserID || previous.lease.NetworkID != connection.lease.NetworkID ||
		previous.lease.FromDeviceID != connection.lease.FromDeviceID || previous.lease.ToDeviceID != connection.lease.ToDeviceID {
		return nil, nil, nil
	}
	delete(manager.inbound, connection.PairID)
	manager.retiring[previous] = struct{}{}
	previous.remoteReplaced = true
	previous.mu.Lock()
	previous.result.State.Stage, previous.result.State.Error = "disconnected", ""
	mux, endpoint := previous.mux, previous.endpoint
	previous.mu.Unlock()
	if endpoint == nil {
		endpoint = manager.inboundEndpoints[connection.PairID]
	}
	return previous, endpoint, mux
}
