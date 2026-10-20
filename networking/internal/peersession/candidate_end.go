package peersession

import (
	"context"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// An ended local carrier does not prove server cancellation. This lightweight
// owner retains only immutable authority, not the transport, mux or gateway.
type endCleanup struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	ticket   protocol.CandidateTicket
	reason   string
	first    chan struct{}
	firstErr error
}

func (manager *Manager) endCandidate(connection *session, reason string) {
	manager.mu.Lock()
	if manager.closed || manager.client == nil || manager.ctx == nil || connection.ticket == nil {
		manager.mu.Unlock()
		return
	}
	ticket := *connection.ticket
	if connection.scopeRetired && reason == "failed" {
		// Scope retirement is explicit revocation, not natural carrier failure;
		// it must not retain this predecessor for another candidate CAS.
		reason = "removed"
	}
	if err := ticket.Verify(manager.config.Authority.PublicKey); err != nil {
		manager.mu.Unlock()
		connection.recordRenewal(err)
		return
	}
	if manager.endJobs == nil {
		manager.endJobs = make(map[string]*endCleanup)
	}
	job := manager.endJobs[ticket.Lease.AttemptID]
	if job == nil {
		ctx, cancel := context.WithCancel(manager.ctx)
		job = &endCleanup{ctx: ctx, cancel: cancel, done: make(chan struct{}), ticket: ticket, reason: reason, first: make(chan struct{})}
		manager.endJobs[ticket.Lease.AttemptID] = job
		manager.endWait.Add(1)
		go manager.runEndCleanup(job)
	} else if reason == "disconnect" || reason == "revoked" || reason == "removed" {
		job.reason = reason
	}
	manager.mu.Unlock()
	select {
	case <-job.first:
		if job.firstErr != nil {
			connection.recordRenewal(job.firstErr)
		}
	case <-manager.ctx.Done():
	}
}

func (manager *Manager) runEndCleanup(job *endCleanup) {
	defer manager.endWait.Done()
	defer func() {
		manager.mu.Lock()
		if manager.endJobs[job.ticket.Lease.AttemptID] == job {
			delete(manager.endJobs, job.ticket.Lease.AttemptID)
		}
		manager.mu.Unlock()
		job.cancel()
		close(job.done)
	}()
	first := true
	for attempt := 0; ; attempt++ {
		done, err := manager.tryEndCleanup(job)
		if first {
			job.firstErr = err
			close(job.first)
			first = false
		}
		if done || candidateAuthorityEnded(err) || job.ctx.Err() != nil {
			return
		}
		index := attempt
		if index >= len(autoconnect.Backoff) {
			index = len(autoconnect.Backoff) - 1
		}
		timer := time.NewTimer(autoconnect.Backoff[index])
		select {
		case <-job.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (manager *Manager) tryEndCleanup(job *endCleanup) (bool, error) {
	if manager.client.Account() != job.ticket.Lease.UserID {
		return false, errors.New("p2p.user_unauthorized")
	}
	fence, err := manager.registration()
	if err != nil {
		return false, err
	}
	manager.mu.Lock()
	reason := job.reason
	manager.mu.Unlock()
	ctx, cancel := context.WithTimeout(job.ctx, 10*time.Second)
	result, err := manager.client.EndCandidate(ctx, protocol.EndCandidate{Registration: fence, Ticket: job.ticket, Reason: reason})
	cancel()
	if err == nil {
		lease := job.ticket.Lease
		if result.AttemptID != lease.AttemptID || result.Generation != lease.Generation || result.Reason != reason || !validActive(result.CurrentActiveAttemptID, result.CurrentActiveGeneration) {
			err = errors.New("p2p.invalid_server_response")
		} else if result.CurrentActiveAttemptID != lease.AttemptID || result.CurrentActiveGeneration != lease.Generation {
			return true, nil
		} else if result.Ended {
			err = errors.New("p2p.invalid_server_response")
		} else {
			err = errors.New("p2p.connection_busy") // predecessor CAS is still retained.
		}
	}
	if candidateAuthorityEnded(err) {
		return false, err
	}
	// A lost/malformed End response may follow its durable effect. Terminal
	// state-by-id is evidence; another live active attempt alone is not enough
	// while this exact candidate still has a pending decision.
	lease := job.ticket.Lease
	ctx, cancel = context.WithTimeout(job.ctx, 10*time.Second)
	state, readErr := manager.client.CandidateState(ctx, protocol.CandidateStateRequest{Registration: fence, AttemptID: lease.AttemptID, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.PairID})
	cancel()
	if readErr == nil {
		readErr = manager.validateCandidateReceipt(job.ticket, state)
	}
	if readErr == nil {
		if state.Decision.Status == "cancelled" || state.Decision.Status == "expired" || (state.Decision.Status == "committed" && (state.CurrentActiveAttemptID != lease.AttemptID || state.CurrentActiveGeneration != lease.Generation)) {
			return true, nil
		}
	}
	if candidateAuthorityEnded(readErr) {
		return false, readErr
	}
	return false, err
}
