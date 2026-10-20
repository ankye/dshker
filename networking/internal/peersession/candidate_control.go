package peersession

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type controlSubscription interface {
	Registration() (protocol.RegistrationFence, error)
	SendCandidate(context.Context, protocol.CandidateTicket, protocol.Signal) error
}

func candidateAuthorityEnded(err error) bool {
	if err == nil {
		return false
	}
	switch err.Error() {
	case "p2p.user_unauthorized", "p2p.network_unauthorized", "p2p.binding_unauthorized", "p2p.pair_revoked":
		return true
	default:
		return false
	}
}

func (manager *Manager) registration() (protocol.RegistrationFence, error) {
	manager.mu.Lock()
	signals := manager.signals
	manager.mu.Unlock()
	if signals == nil {
		return protocol.RegistrationFence{}, errors.New("p2p.signalling_not_ready")
	}
	active, ok := signals.current()
	if !ok {
		return protocol.RegistrationFence{}, errors.New("p2p.signalling_not_ready")
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return protocol.RegistrationFence{}, errors.New("p2p.protocol_mismatch")
	}
	return control.Registration()
}

func (manager *Manager) sendCandidate(ctx context.Context, connection *session, signal protocol.Signal) error {
	manager.mu.Lock()
	signals, ticket := manager.signals, connection.ticket
	manager.mu.Unlock()
	if signals == nil || ticket == nil {
		return errors.New("p2p.signalling_not_ready")
	}
	active, ok := signals.current()
	if !ok {
		return errors.New("p2p.signalling_not_ready")
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return errors.New("p2p.protocol_mismatch")
	}
	// Capture this dispatch's actual socket/fence once. Completion must not
	// borrow a replacement registration and "sent" is not a receiver ACK.
	fence, _ := control.Registration()
	record, logged := manager.captureCandidatePhase(connection, signal.Type, signals, active, fence)
	if logged {
		writeCandidateControlDiagnostic(record)
	}
	err := control.SendCandidate(ctx, *ticket, signal)
	if logged {
		disposition := "sent"
		if err != nil {
			disposition = "failed"
		}
		if result, ok := candidateControlResult(record, disposition, err); ok {
			writeCandidateControlDiagnostic(result)
		}
	}
	return err
}

// Diagnostic-only snapshot. It does not grant admission, change a request or
// return an authority error to a transport operation.
func (manager *Manager) captureCandidatePhase(connection *session, event string, owner *signaling, active subscription, fence protocol.RegistrationFence) (candidateControlDiagnostic, bool) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if connection.ticket == nil {
		return candidateControlDiagnostic{}, false
	}
	current := manager.currentInboundSubscriptionLocked(&targetPromotionAdmission{owner: owner, active: active})
	return manager.captureCandidateControlDiagnosticLocked(event, "started", nil, *connection.ticket, fence, current)
}

func (manager *Manager) captureCandidateGather(connection *session, event string) (candidateControlDiagnostic, bool) {
	manager.mu.Lock()
	owner := manager.signals
	manager.mu.Unlock()
	var active subscription
	var fence protocol.RegistrationFence
	if owner != nil {
		active, _ = owner.current()
		if control, ok := active.(controlSubscription); ok {
			fence, _ = control.Registration()
		}
	}
	return manager.captureCandidatePhase(connection, event, owner, active, fence)
}

func (manager *Manager) candidateAction(connection *session) (protocol.CandidateAction, error) {
	fence, err := manager.registration()
	if err != nil {
		return protocol.CandidateAction{}, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if connection.ticket == nil {
		return protocol.CandidateAction{}, errors.New("p2p.candidate_scope_mismatch")
	}
	if manager.client.Account() != connection.ticket.Lease.UserID {
		return protocol.CandidateAction{}, errors.New("p2p.user_unauthorized")
	}
	return protocol.CandidateAction{Registration: fence, Ticket: *connection.ticket}, nil
}

func (manager *Manager) candidateState(connection *session) (protocol.CandidateState, error) {
	return manager.candidateStateContext(manager.ctx, connection)
}

func (manager *Manager) candidateStateContext(parent context.Context, connection *session) (protocol.CandidateState, error) {
	action, err := manager.candidateAction(connection)
	if err != nil {
		return protocol.CandidateState{}, err
	}
	lease := action.Ticket.Lease
	request := protocol.CandidateStateRequest{Registration: action.Registration, AttemptID: lease.AttemptID, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.PairID}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	connection.controlMu.Lock()
	defer connection.controlMu.Unlock()
	state, err := manager.client.CandidateState(ctx, request)
	if err == nil {
		err = manager.validateCandidateState(connection, state)
	}
	return state, err
}

func (manager *Manager) validateCandidateState(connection *session, state protocol.CandidateState) error {
	manager.mu.Lock()
	ticket := connection.ticket
	manager.mu.Unlock()
	if ticket == nil {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	return manager.validateCandidateReceipt(*ticket, state)
}

func (manager *Manager) validateCandidateReceipt(ticket protocol.CandidateTicket, state protocol.CandidateState) error {
	if state.Ticket != ticket || state.Ticket.Verify(manager.config.Authority.PublicKey) != nil ||
		!validActive(state.CurrentActiveAttemptID, state.CurrentActiveGeneration) {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	if err := state.LatestLease.VerifyCandidateScope(manager.config.Authority.PublicKey, ticket); err != nil {
		return err
	}
	if err := state.Decision.Lease.VerifyCandidateScope(manager.config.Authority.PublicKey, ticket); err != nil {
		return err
	}
	switch state.Decision.Status {
	case "pending":
		if state.Decision.Reason != "" || state.Decision.DecidedAt != 0 {
			return errors.New("p2p.invalid_server_response")
		}
	case "committed":
		if state.Decision.Reason != "" || state.Decision.DecidedAt <= 0 {
			return errors.New("p2p.invalid_server_response")
		}
	case "cancelled", "expired":
		if _, ok := protocol.Refusal(errors.New(state.Decision.Reason)); !ok || state.Decision.DecidedAt <= 0 {
			return errors.New("p2p.invalid_server_response")
		}
	default:
		return errors.New("p2p.invalid_server_response")
	}
	return nil
}

func validActive(attempt string, generation uint64) bool {
	return (attempt == "" && generation == 0) || (protocol.ValidNonce(attempt) && protocol.ValidGeneration(generation))
}

func (manager *Manager) receiveControl(active subscription, event controlplane.SignalEvent) bool {
	control, isControl := active.(controlSubscription)
	if !isControl {
		return false
	}
	manager.mu.Lock()
	signals := manager.signals
	manager.mu.Unlock()
	if signals == nil {
		manager.recordReceivedCandidate(event, "stale_fence", errors.New("p2p.registration_stale"), protocol.RegistrationFence{}, false)
		return true
	}
	current, ok := signals.current()
	if !ok || current != active {
		manager.recordReceivedCandidate(event, "stale_fence", errors.New("p2p.registration_stale"), protocol.RegistrationFence{}, false)
		return true
	}
	fence, err := control.Registration()
	if err != nil {
		manager.recordReceivedCandidate(event, "stale_fence", err, protocol.RegistrationFence{}, true)
		return true
	}
	switch event.Type {
	case "candidate":
		manager.acceptCandidateFrom(event.Ticket, &targetPromotionAdmission{owner: signals, active: active, fence: fence})
	case "candidate-decision":
		manager.mu.Lock()
		connection := manager.sessionByAttemptLocked(event.State.Ticket.Lease.AttemptID)
		manager.mu.Unlock()
		if connection != nil {
			if validationErr := manager.validateCandidateState(connection, event.State); validationErr == nil {
				manager.mu.Lock()
				retired := connection.promoted && event.State.Decision.Status == "committed" && (event.State.CurrentActiveAttemptID != connection.lease.AttemptID || event.State.CurrentActiveGeneration != connection.lease.Generation)
				promoteTarget := !connection.promoted && connection.lease.ToDeviceID == manager.config.Device.DeviceID && event.State.Decision.Status == "committed" && event.State.FromReady && event.State.ToReady && event.State.CurrentActiveAttemptID == connection.lease.AttemptID && event.State.CurrentActiveGeneration == connection.lease.Generation
				manager.mu.Unlock()
				if retired {
					connection.stop("active_authority_ended", errors.New("p2p.stale_generation"))
					manager.recordReceivedCandidate(event, "retired", nil, fence, true)
				} else if promoteTarget {
					// No HTTP or Host callback is involved in target promotion: the
					// already staged listener and mux become current in one barrier.
					admission := &targetPromotionAdmission{owner: signals, active: active, fence: fence}
					if err := manager.promoteCandidateFrom(connection, event.State, false, admission); err != nil {
						connection.recordRenewal(err)
						connection.notify()
						manager.recordReceivedCandidate(event, "refused", err, fence, true)
					} else {
						manager.recordReceivedCandidate(event, "accepted", nil, fence, true)
					}
				} else if terminal := candidateDecisionError(event.State); terminal != nil {
					if connection.lease.ToDeviceID == manager.config.Device.DeviceID {
						_ = manager.retireInboundTerminal(connection, event.State, &targetPromotionAdmission{owner: signals, active: active, fence: fence})
					} else {
						connection.stop("candidate_decided", terminal)
						manager.recordReceivedCandidate(event, "accepted", nil, fence, true)
					}
				} else {
					connection.notify()
					manager.recordReceivedCandidate(event, "accepted", nil, fence, true)
				}
			} else {
				manager.recordReceivedCandidate(event, "refused", validationErr, fence, true)
			}
		} else {
			manager.recordReceivedCandidate(event, "no_owner", nil, fence, true)
		}
	case "peer-registration":
		manager.peerRegistration(event.Registration)
	case "signal":
		if event.Ticket.Version == 0 {
			return false
		}
		manager.mu.Lock()
		connection := manager.sessionByAttemptLocked(event.Signal.AttemptID)
		valid := connection != nil && connection.ticket != nil && *connection.ticket == event.Ticket && connection.ctx.Err() == nil
		disposition := "no_owner"
		var cause error
		if valid {
			disposition = "accepted"
			if queued := manager.inboundAdmissions[connection.PairID]; queued != nil && queued.connection == connection {
				disposition = "queued"
			}
			select {
			case connection.signalInbox <- event.Signal:
			default:
				cause, disposition = errors.New("p2p.signal_limit"), "refused"
				connection.stop("candidate_signal_limit", cause)
			}
		} else if connection != nil && connection.ctx.Err() != nil {
			disposition, cause = "canceled", connection.ctx.Err()
		}
		diagnostic, log := manager.captureCandidateControlDiagnosticLocked("signal", disposition, cause, event.Ticket, fence, true)
		manager.mu.Unlock()
		if log {
			writeCandidateControlDiagnostic(diagnostic)
		}
	case "revoked":
		manager.revoke(event.PairID)
	default:
		return false
	}
	return true
}

func (manager *Manager) recordReceivedCandidate(event controlplane.SignalEvent, disposition string, cause error, fence protocol.RegistrationFence, current bool) {
	ticket := event.Ticket
	kind := event.Type
	if kind == "candidate-decision" {
		kind, ticket = "decision", event.State.Ticket
	} else if kind == "candidate" {
		kind = "prepared"
	} else if kind != "signal" {
		return
	}
	if record, ok := manager.captureCandidateControlDiagnostic(kind, disposition, cause, ticket, fence, current); ok {
		writeCandidateControlDiagnostic(record)
	}
}

// Resolve early cancellation while transport establishment is still waiting.
// It only interrupts resources after an authoritative terminal decision; once
// commit was dispatched, the main resolver retains ownership instead.
type candidateDecisionObserver struct {
	cancel        context.CancelFunc
	done          chan struct{}
	once          sync.Once
	unknownCancel bool
}

func (manager *Manager) startCandidateDecisionObserver(connection *session) *candidateDecisionObserver {
	ctx, cancel := context.WithCancel(connection.ctx)
	observer := &candidateDecisionObserver{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(observer.done)
		observer.unknownCancel = manager.observeCandidateDecision(ctx, connection)
	}()
	return observer
}

func (observer *candidateDecisionObserver) stop() bool {
	observer.once.Do(func() { observer.cancel(); <-observer.done })
	return observer.unknownCancel
}

func (manager *Manager) observeCandidateDecision(ctx context.Context, connection *session) (unknownCancel bool) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return unknownCancel
		case <-connection.changed:
		case <-ticker.C:
		}
		manager.mu.Lock()
		promoted, dispatched := connection.promoted, connection.commitDispatched
		manager.mu.Unlock()
		if promoted || dispatched {
			return unknownCancel
		}
		var state protocol.CandidateState
		var err error
		if connection.cancellationRequested() {
			action, actionErr := manager.candidateAction(connection)
			err = actionErr
			if err == nil {
				connection.controlMu.Lock()
				unknownCancel = true
				state, err = manager.client.CancelCandidate(ctx, action)
				connection.controlMu.Unlock()
			}
			if err == nil {
				err = manager.validateCandidateState(connection, state)
			}
		} else {
			state, err = manager.candidateStateContext(ctx, connection)
		}
		if err != nil {
			if candidateAuthorityEnded(err) {
				connection.stop("candidate_authorization_ended", err)
				return false
			}
			continue
		}
		if terminal := candidateDecisionError(state); terminal != nil {
			connection.complete(Connected{}, terminal)
			connection.stop("candidate_decided", terminal)
			return false
		}
		if state.Decision.Status == "committed" {
			unknownCancel = false
		}
	}
}

func (manager *Manager) receiveCandidateSignal(connection *session, signal protocol.Signal) {
	ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	defer cancel()
	record, logged := manager.captureCandidateGather(connection, signal.Type)
	if logged {
		writeCandidateControlDiagnostic(record)
	}
	var err error
	if signal.Type == "offer" {
		var answer protocol.Signal
		answer, err = connection.transport.AcceptOffer(ctx, signal)
		writeCandidateApplyResult(record, logged, err)
		if err == nil {
			err = manager.sendCandidate(ctx, connection, answer)
		}
	} else {
		err = connection.transport.AcceptAnswer(signal)
		writeCandidateApplyResult(record, logged, err)
	}
	if err != nil {
		connection.stop("candidate_signal_failed", err)
	}
}

func writeCandidateApplyResult(record candidateControlDiagnostic, logged bool, err error) {
	if !logged {
		return
	}
	disposition := "applied"
	if err != nil {
		disposition = "failed"
	}
	if result, ok := candidateControlResult(record, disposition, err); ok {
		writeCandidateControlDiagnostic(result)
	}
}

func (connection *session) notify() {
	select {
	case connection.changed <- struct{}{}:
	default:
	}
}

func (connection *session) requestCancel() {
	connection.cancelOnce.Do(func() { close(connection.cancelRequested) })
	connection.notify()
}

func (connection *session) cancellationRequested() bool {
	select {
	case <-connection.cancelRequested:
		return true
	default:
		return false
	}
}

func (connection *session) complete(result Connected, err error) {
	connection.readyOnce.Do(func() {
		connection.mu.Lock()
		connection.result, connection.err = result, err
		if err != nil {
			connection.refusal = namedRefusal(err, result.State.Stage != "punching")
		}
		connection.mu.Unlock()
		close(connection.ready)
	})
}

func waitCandidate(ctx context.Context, connection *session) (Connected, error) {
	select {
	case <-ctx.Done():
		connection.requestCancel()
		return Connected{}, ctx.Err()
	case <-connection.ready:
		connection.mu.Lock()
		defer connection.mu.Unlock()
		return connection.result, connection.err
	}
}
