package peersession

import (
	"context"
	"errors"
	"reflect"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// An admission owns one immutable successor and its existing bounded signal
// inbox, not a transport. Its read context is independent of the retiring
// candidate: canceling that carrier is not evidence of a terminal decision.
type inboundAdmission struct {
	connection *session
	previous   *session
	owner      *signaling
	active     subscription
	fence      protocol.RegistrationFence
	pin        controlplane.PairIdentity
	done       chan struct{}
	err        error // published by closing done
}

// Caller holds manager.mu after the successful pin/catalog publication. This
// must not be called while constructing a temporary map that can roll back.
func (manager *Manager) cancelChangedAdmissionLocked(pairID string) {
	if job := manager.inboundAdmissions[pairID]; job != nil && !reflect.DeepEqual(manager.pins[pairID], job.pin) {
		job.connection.stop("pair_identity_changed", errors.New("p2p.pair_unauthorized"))
	}
}

func (manager *Manager) finishInboundSubscription(active subscription) {
	manager.mu.Lock()
	var pending []*inboundAdmission
	for _, job := range manager.inboundAdmissions {
		if job.active == active {
			job.connection.stop("subscription_ended", errors.New("p2p.registration_stale"))
			pending = append(pending, job)
		}
	}
	manager.mu.Unlock()
	// The receive worker joins only its own read/commit phase, never a newer
	// subscription, transport cleanup, End response or external Wake callback.
	for _, job := range pending {
		<-job.done
	}
}

// Caller holds manager.mu (and signaling.mu when used at a slot barrier).
func (manager *Manager) checkInboundAdmissionLocked(job *inboundAdmission) error {
	if job.connection.ctx.Err() != nil || manager.inboundAdmissions[job.connection.PairID] != job ||
		!reflect.DeepEqual(manager.pins[job.connection.PairID], job.pin) {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	return nil
}

func (manager *Manager) currentInboundSubscriptionLocked(captured *targetPromotionAdmission) bool {
	if captured == nil || captured.owner == nil || manager.signals != captured.owner {
		return false
	}
	captured.owner.mu.Lock()
	current := captured.owner.active == captured.active && captured.active != nil
	captured.owner.mu.Unlock()
	return current
}

func (manager *Manager) startInboundCandidate(connection *session) {
	go func() {
		if err := manager.createCandidateTransport(connection); err != nil {
			manager.failUnstartedCandidate(connection, err)
			return
		}
		manager.runCandidate(connection, false)
	}()
}

// Caller holds manager.mu; success also holds the captured signaling mutex.
// This is the same Manager -> signaling lock order as target promotion.
func (manager *Manager) lockInboundScopeLocked(ticket protocol.CandidateTicket, admission *targetPromotionAdmission) (func(), error) {
	if manager.closed || manager.ctx.Err() != nil {
		return nil, errors.New("p2p.helper_unavailable")
	}
	if !manager.candidatesActive {
		return nil, errors.New("p2p.candidate_unsupported")
	}
	if manager.accountUserID != ticket.Lease.UserID || manager.client.Account() != ticket.Lease.UserID ||
		ticket.Lease.ToDeviceID != manager.config.Device.DeviceID || ticket.ToCoreInstanceID != manager.config.CoreInstanceID {
		return nil, errors.New("p2p.candidate_scope_mismatch")
	}
	if admission == nil || admission.owner == nil || manager.signals != admission.owner {
		return nil, errors.New("p2p.registration_stale")
	}
	owner := admission.owner
	owner.mu.Lock()
	refuse := func() (func(), error) { owner.mu.Unlock(); return nil, errors.New("p2p.registration_stale") }
	if owner.closed || owner.down || owner.active != admission.active || owner.active == nil {
		return refuse()
	}
	select {
	case <-owner.active.Done():
		return refuse()
	default:
	}
	control, ok := owner.active.(controlSubscription)
	if !ok {
		return refuse()
	}
	fence, err := control.Registration()
	if err != nil || fence != admission.fence || fence.ServerEpoch != ticket.ServerEpoch || fence.CoreInstanceID != manager.config.CoreInstanceID {
		return refuse()
	}
	return owner.mu.Unlock, nil
}

func (manager *Manager) acceptCandidateFrom(ticket protocol.CandidateTicket, captured *targetPromotionAdmission) {
	err := ticket.Verify(manager.config.Authority.PublicKey)
	manager.mu.Lock()
	var unlock func()
	if err == nil {
		unlock, err = manager.lockInboundScopeLocked(ticket, captured)
	}
	var connection *session
	var job *inboundAdmission
	disposition := "refused"
	if err == nil {
		var previous *session
		var duplicate bool
		connection, previous, duplicate, err = manager.reserveInboundCandidateLocked(ticket)
		if err == nil {
			if duplicate {
				disposition = "accepted"
				if queued := manager.inboundAdmissions[connection.PairID]; queued != nil && queued.connection == connection {
					disposition = "queued"
				}
				connection = nil // duplicate never starts a second worker
			} else if previous != nil {
				pairID := previous.PairID
				connection = newInboundCandidateSession(manager.ctx, pairID, ticket)
				job = &inboundAdmission{connection: connection, previous: previous, owner: captured.owner, active: captured.active, fence: captured.fence, pin: manager.pins[pairID], done: make(chan struct{})}
				if manager.inboundAdmissions == nil {
					manager.inboundAdmissions = make(map[string]*inboundAdmission)
				}
				manager.inboundAdmissions[pairID] = job
				// Add and Close's closed barrier share manager.mu.
				manager.inboundAdmissionWait.Add(1)
				disposition = "queued"
			} else {
				disposition = "accepted"
			}
		}
	}
	if unlock != nil {
		unlock()
	}
	fence := protocol.RegistrationFence{}
	if captured != nil {
		fence = captured.fence
	}
	current := manager.currentInboundSubscriptionLocked(captured)
	diagnostic, log := manager.captureCandidateControlDiagnosticLocked("prepared", disposition, err, ticket, fence, current)
	manager.mu.Unlock()
	if log {
		writeCandidateControlDiagnostic(diagnostic)
	}
	if job != nil {
		go manager.runInboundAdmission(job)
	} else if connection != nil {
		manager.startInboundCandidate(connection)
	}
}

// Shared reservation core used by the ordered receiver and explicit startup
// owners. Its caller has validated the same captured registration barrier.
// A busy predecessor is returned without allocating or starting a successor.
func (manager *Manager) reserveInboundCandidateLocked(ticket protocol.CandidateTicket) (*session, *session, bool, error) {
	pairID, pinned := manager.pairForRemoteLocked(ticket.Lease.FromDeviceID, ticket.Lease.NetworkID)
	if !pinned {
		return nil, nil, false, errors.New("p2p.pair_unauthorized")
	}
	if primary := manager.inbound[pairID]; primary != nil && primary.promoted && primary.ticket != nil && *primary.ticket == ticket {
		// A late Prepared for the exact committed primary is idempotent. It
		// neither rebuilds a second startup owner nor grants fresh readiness.
		return primary, nil, true, nil
	}
	if queued := manager.inboundAdmissions[pairID]; queued != nil {
		if *queued.connection.ticket == ticket {
			return queued.connection, nil, true, nil
		}
		return nil, nil, false, errors.New("p2p.connection_busy")
	}
	if previous := manager.inboundCandidates[pairID]; previous != nil {
		if previous.ticket != nil && *previous.ticket == ticket {
			return previous, nil, true, nil
		}
		return nil, previous, false, nil
	}
	connection := newInboundCandidateSession(manager.ctx, pairID, ticket)
	manager.installInboundCandidateLocked(connection)
	return connection, nil, false, nil
}

func newInboundCandidateSession(ctx context.Context, pairID string, ticket protocol.CandidateTicket) *session {
	connection := newSession(ctx)
	connection.PairID, connection.ticket, connection.lease = pairID, &ticket, ticket.Lease
	return connection
}

func (manager *Manager) installInboundCandidateLocked(connection *session) {
	connection.predecessor = manager.inbound[connection.PairID]
	if previous := connection.predecessor; previous != nil && previous.transport != nil {
		live := previous.transport.LiveState()
		connection.predecessorWindow, connection.predecessorWasSuspended = live.Window, live.Suspended || previous.remoteReplaced
	}
	if manager.inboundCandidates == nil {
		manager.inboundCandidates = make(map[string]*session)
	}
	manager.inboundCandidates[connection.PairID] = connection
}

func (manager *Manager) runInboundAdmission(job *inboundAdmission) {
	defer manager.inboundAdmissionWait.Done()
	err := manager.resolveInboundAdmission(job)
	if err != nil {
		job.connection.stop("candidate_admission_refused", err)
	}
	manager.mu.Lock()
	disposition := "accepted"
	if err != nil {
		disposition = "refused"
	}
	captured := &targetPromotionAdmission{owner: job.owner, active: job.active, fence: job.fence}
	current := manager.currentInboundSubscriptionLocked(captured)
	diagnostic, log := manager.captureCandidateControlDiagnosticLocked("prepared", disposition, err, *job.connection.ticket, job.fence, current)
	if manager.inboundAdmissions[job.connection.PairID] == job {
		delete(manager.inboundAdmissions, job.connection.PairID)
	}
	if err != nil {
		// Keep cleanup/Close ownership even after the queued slot is released.
		if manager.retiring == nil {
			manager.retiring = make(map[*session]struct{})
		}
		manager.retiring[job.connection] = struct{}{}
	}
	// Slot removal and phase completion share the Manager barrier: receive
	// cannot miss a still-open reader after observing its map entry removed.
	job.err = err
	close(job.done)
	manager.mu.Unlock()
	if log {
		writeCandidateControlDiagnostic(diagnostic)
	}
	if err != nil {
		// The retiring connection owns cleanup/End through connection.done.
		// The admission WaitGroup ends after this transfer, not after the
		// existing cleanup's generic Wake callback (which may enter Host).
		go manager.failUnstartedCandidate(job.connection, err)
		return
	}
	manager.startInboundCandidate(job.connection)
}

func (manager *Manager) resolveInboundAdmission(job *inboundAdmission) error {
	// The watcher is part of this worker's join, including the late-body case.
	watch, cancelWatch := context.WithCancel(job.connection.ctx)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-watch.Done():
		case <-job.active.Done():
			job.connection.stop("subscription_ended", errors.New("p2p.registration_stale"))
		}
	}()
	defer func() { cancelWatch(); <-watchDone }()
	manager.mu.Lock()
	oldTicket := job.previous.ticket
	captured := &targetPromotionAdmission{owner: job.owner, active: job.active, fence: job.fence, queued: job}
	unlock, admissionErr := manager.lockInboundScopeLocked(*job.connection.ticket, captured)
	if admissionErr == nil {
		admissionErr = manager.checkInboundAdmissionLocked(job)
		unlock()
	}
	manager.mu.Unlock()
	if admissionErr != nil {
		return admissionErr
	}
	if oldTicket == nil {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	lease := oldTicket.Lease
	request := protocol.CandidateStateRequest{Registration: job.fence, AttemptID: lease.AttemptID, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.PairID}
	ctx, cancel := context.WithTimeout(job.connection.ctx, 10*time.Second)
	state, err := manager.client.CandidateState(ctx, request)
	cancel()
	if err != nil {
		return err
	}
	if err := manager.validateCandidateReceipt(*oldTicket, state); err != nil {
		return err
	}
	if state.Decision.Status == "pending" {
		return errors.New("p2p.connection_busy")
	}
	if state.Decision.Status == "committed" && state.CurrentActiveAttemptID == lease.AttemptID && state.CurrentActiveGeneration == lease.Generation {
		var retirement targetPromotionRetirement
		captured.retirement = &retirement
		err = manager.promoteCandidateFrom(job.previous, state, false, captured)
		if err != nil {
			// The existing barrier explicitly retires a committed dead carrier.
			// Its per-call receipt survives old cleanup completing before this
			// return; an arbitrary not_connected or cancellation has no receipt.
			deadRetired := err.Error() == "p2p.not_connected" && retirement.previous == job.previous && retirement.queued == job
			if !deadRetired {
				return err
			}
		}
	} else {
		if err := manager.retireInboundTerminal(job.previous, state, captured); err != nil {
			return err
		}
	}
	manager.mu.Lock()
	unlock, err = manager.lockInboundScopeLocked(*job.connection.ticket, captured)
	if err == nil {
		if scopeErr := manager.checkInboundAdmissionLocked(job); scopeErr != nil {
			err = scopeErr
		} else if current := manager.inboundCandidates[job.connection.PairID]; current != nil {
			err = errors.New("p2p.connection_busy")
		} else {
			manager.installInboundCandidateLocked(job.connection)
		}
		unlock()
	}
	manager.mu.Unlock()
	return err
}

// Receipt validation is historical authority, not a current lease grant. The
// slot is released before resource joins/End, while retiring retains the exact
// old pointer so its later finish cannot delete a successor.
func (manager *Manager) retireInboundTerminal(connection *session, state protocol.CandidateState, captured *targetPromotionAdmission) error {
	if connection.ticket == nil {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	if err := manager.validateCandidateReceipt(*connection.ticket, state); err != nil {
		return err
	}
	terminal := candidateDecisionError(state)
	if terminal == nil {
		if state.Decision.Status != "committed" || state.CurrentActiveAttemptID == connection.lease.AttemptID && state.CurrentActiveGeneration == connection.lease.Generation {
			return errors.New("p2p.connection_busy")
		}
		terminal = errors.New("p2p.stale_generation")
	}
	manager.mu.Lock()
	// The registration belongs to the new receipt owner. Historical tickets
	// may have a prior epoch, so use that owner's new ticket for scope checks.
	scopeTicket := *connection.ticket
	if captured.queued != nil {
		scopeTicket = *captured.queued.connection.ticket
	}
	unlock, err := manager.lockInboundScopeLocked(scopeTicket, captured)
	if err == nil {
		if captured.queued != nil {
			err = manager.checkInboundAdmissionLocked(captured.queued)
		}
		if err == nil && (manager.inboundCandidates[connection.PairID] == connection || manager.inbound[connection.PairID] == connection) {
			if manager.retiring == nil {
				manager.retiring = make(map[*session]struct{})
			}
			manager.retiring[connection] = struct{}{}
			if manager.inboundCandidates[connection.PairID] == connection {
				delete(manager.inboundCandidates, connection.PairID)
			}
			if manager.inbound[connection.PairID] == connection {
				delete(manager.inbound, connection.PairID)
			}
		}
		unlock()
	}
	disposition := "retired"
	if err != nil {
		disposition = "refused"
	}
	current := manager.currentInboundSubscriptionLocked(captured)
	diagnostic, log := manager.captureCandidateControlDiagnosticLocked("decision", disposition, err, *connection.ticket, captured.fence, current)
	manager.mu.Unlock()
	if log {
		writeCandidateControlDiagnostic(diagnostic)
	}
	if err == nil {
		connection.stop("candidate_decided", terminal)
	}
	return err
}
