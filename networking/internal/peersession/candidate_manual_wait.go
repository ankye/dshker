package peersession

import (
	"context"
	"errors"
	"reflect"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// This owner reserves the next explicit admission, not the borrowed transport.
// Removing it under manager.mu is also its cancellation epoch: repinning the
// same identity or logging into the same account cannot resurrect an old click.
type manualCandidateWait struct {
	pairID     string
	generation uint64
	borrowed   *session
	pin        controlplane.PairIdentity
	owner      *signaling
	active     subscription
	fence      protocol.RegistrationFence
	cancelled  chan struct{}
	err        error // published by closing cancelled
}

func (manager *Manager) reserveConnectCandidate(ctx context.Context, pairID string, generation uint64, requested, resume bool) (*session, error) {
	manager.mu.Lock()
	connection, err := manager.reserveCandidateLocked(pairID, generation, requested, resume, nil)
	if err == nil || !requested || resume || err.Error() != "p2p.connection_busy" {
		manager.mu.Unlock()
		return connection, err
	}
	borrowed := manager.candidates[pairID]
	if borrowed == nil || (borrowed.requestWorkbench && !borrowed.resumeWorkbench) || manager.manualWaiters[pairID] != nil {
		manager.mu.Unlock()
		return nil, err
	}
	if generation <= manager.generations[pairID] {
		manager.mu.Unlock()
		return nil, errors.New("p2p.stale_generation")
	}
	waiter := &manualCandidateWait{pairID: pairID, generation: generation, borrowed: borrowed, pin: manager.pins[pairID], owner: manager.signals, cancelled: make(chan struct{})}
	waiter.pin.Initiator.PublicKey = append([]byte(nil), waiter.pin.Initiator.PublicKey...)
	waiter.pin.Target.PublicKey = append([]byte(nil), waiter.pin.Target.PublicKey...)
	unlock, err := manager.lockManualWaitScopeLocked(waiter, false)
	if err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	if manager.manualWaiters == nil {
		manager.manualWaiters = make(map[string]*manualCandidateWait)
	}
	manager.manualWaiters[pairID] = waiter
	unlock()
	manager.mu.Unlock()
	defer func() {
		manager.mu.Lock()
		if manager.manualWaiters[pairID] == waiter {
			delete(manager.manualWaiters, pairID)
		}
		manager.mu.Unlock()
		manager.wake(pairID)
	}()
	return manager.waitManualCandidate(ctx, waiter)
}

func (manager *Manager) waitManualCandidate(ctx context.Context, waiter *manualCandidateWait) (*session, error) {
	ready, done := waiter.borrowed.ready, waiter.borrowed.done
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-manager.ctx.Done():
			return nil, errors.New("p2p.helper_unavailable")
		case <-waiter.cancelled:
			return nil, waiter.err
		case <-waiter.active.Done():
			return nil, errors.New("p2p.registration_stale")
		case <-ready:
			ready = nil
		case <-done:
			done = nil
		}
		manager.mu.Lock()
		if err := ctx.Err(); err != nil {
			manager.mu.Unlock()
			return nil, err
		}
		if manager.manualWaiters[waiter.pairID] != waiter {
			err := waiter.err
			manager.mu.Unlock()
			if err == nil {
				err = errors.New("p2p.connection_cancelled")
			}
			return nil, err
		}
		// A healthy promoted primary keeps done open for its lifetime. A failed
		// ready result, however, does not release its cleanup ownership yet.
		promoted := waiter.borrowed.promoted && manager.sessions[waiter.pairID] == waiter.borrowed
		cleaned := channelClosed(waiter.borrowed.done)
		if manager.candidates[waiter.pairID] == nil && (promoted || cleaned) {
			unlock, err := manager.lockManualWaitScopeLocked(waiter, true)
			if err != nil {
				manager.mu.Unlock()
				return nil, err
			}
			connection, err := manager.reserveCandidateLocked(waiter.pairID, waiter.generation, true, false, waiter)
			if err == nil {
				delete(manager.manualWaiters, waiter.pairID)
			}
			unlock()
			manager.mu.Unlock()
			return connection, err
		}
		manager.mu.Unlock()
	}
}

// Caller holds manager.mu; success also holds signaling.mu through reservation.
func (manager *Manager) lockManualWaitScopeLocked(waiter *manualCandidateWait, captured bool) (func(), error) {
	if manager.closed || manager.ctx.Err() != nil {
		return nil, errors.New("p2p.helper_unavailable")
	}
	if !manager.candidatesActive {
		return nil, errors.New("p2p.candidate_unsupported")
	}
	if manager.accountUserID != waiter.pin.Initiator.UserID || manager.client.Account() != waiter.pin.Initiator.UserID || !reflect.DeepEqual(manager.pins[waiter.pairID], waiter.pin) {
		return nil, errors.New("p2p.pair_unauthorized")
	}
	owner := waiter.owner
	if owner == nil || manager.signals != owner {
		return nil, errors.New("p2p.registration_stale")
	}
	owner.mu.Lock()
	refuse := func() (func(), error) { owner.mu.Unlock(); return nil, errors.New("p2p.registration_stale") }
	if owner.closed || owner.down || owner.active == nil || (captured && owner.active != waiter.active) {
		return refuse()
	}
	if channelClosed(owner.active.Done()) {
		return refuse()
	}
	control, ok := owner.active.(controlSubscription)
	if !ok {
		return refuse()
	}
	fence, err := control.Registration()
	if err != nil || fence.CoreInstanceID != manager.config.CoreInstanceID || (captured && fence != waiter.fence) {
		return refuse()
	}
	if !captured {
		waiter.active, waiter.fence = owner.active, fence
	}
	return owner.mu.Unlock, nil
}

func channelClosed(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}

func (manager *Manager) cancelManualWaitLocked(pairID, code string) {
	if waiter := manager.manualWaiters[pairID]; waiter != nil {
		delete(manager.manualWaiters, pairID)
		waiter.err = errors.New(code)
		close(waiter.cancelled)
	}
}

func (manager *Manager) cancelAllManualWaitsLocked(code string) {
	for pairID := range manager.manualWaiters {
		manager.cancelManualWaitLocked(pairID, code)
	}
}

func (manager *Manager) cancelChangedManualWaitLocked(pairID string) {
	if waiter := manager.manualWaiters[pairID]; waiter != nil && !reflect.DeepEqual(manager.pins[pairID], waiter.pin) {
		manager.cancelManualWaitLocked(pairID, "p2p.pair_unauthorized")
	}
}
