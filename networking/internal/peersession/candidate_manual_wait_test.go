package peersession

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

type manualWaitContext struct {
	context.Context
	once    sync.Once
	waiting chan struct{}
}

type manualReservationResult struct {
	connection *session
	err        error
}

func startManualReservation(t *testing.T, manager *Manager, pairID string, generation uint64) (<-chan manualReservationResult, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	observed := &manualWaitContext{Context: ctx, waiting: make(chan struct{})}
	done := make(chan manualReservationResult, 1)
	go func() {
		connection, err := manager.reserveConnectCandidate(observed, pairID, generation, true, false)
		done <- manualReservationResult{connection, err}
	}()
	select {
	case result := <-done:
		cancel()
		t.Fatal("manual reservation did not wait", result.err)
	case <-observed.waiting:
	case <-manager.ctx.Done():
		cancel()
		t.Fatal("manual reservation did not enter its cancellable wait")
	}
	t.Cleanup(cancel)
	return done, cancel
}

func backgroundManualFixture(t *testing.T) (*Manager, *session) {
	t.Helper()
	manager, _, _ := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	background, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.finish(background.PairID, background) })
	return manager, background
}

func TestManualWorkbenchCreatesItsOwnCandidateAfterBackgroundPromotion(t *testing.T) {
	manager, background := backgroundManualFixture(t)
	done, _ := startManualReservation(t, manager, background.PairID, 2)
	manager.mu.Lock()
	background.promoted = true
	delete(manager.candidates, background.PairID)
	manager.sessions[background.PairID] = background
	manager.mu.Unlock()
	background.complete(Connected{}, nil)
	select {
	case result := <-done:
		if result.err != nil || result.connection == nil {
			t.Fatal("promoted primary's lifetime blocked the explicit request", result.err)
		}
		defer manager.finish(background.PairID, result.connection)
		if result.connection == background || result.connection.prepare.AttemptID == background.prepare.AttemptID || result.connection.prepare.Generation != 2 || !result.connection.requestWorkbench || result.connection.resumeWorkbench || result.connection.predecessor != background || !manager.WorkbenchRequested(background.PairID) {
			t.Fatal("handoff changed the borrowed negotiation or lost explicit identity")
		}
		if channelClosed(background.done) || background.cancellationRequested() || background.requestWorkbench {
			t.Fatal("manual handoff retired or upgraded the healthy borrowed primary")
		}
	case <-manager.ctx.Done():
		t.Fatal("manual request waited for healthy primary lifetime instead of promotion")
	}
}

func TestManualWorkbenchWaitsForFailedCleanupAndKeepsReservationPriority(t *testing.T) {
	manager, background := backgroundManualFixture(t)
	done, _ := startManualReservation(t, manager, background.PairID, 2)
	background.complete(Connected{}, errors.New("p2p.runtime_unavailable"))
	// Cleanup has detached the slot but has not closed done. Its waiting owner
	// must keep a new engine retry from taking the gap between those barriers.
	manager.mu.Lock()
	delete(manager.candidates, background.PairID)
	_, err := manager.reserveCandidateLocked(background.PairID, 3, false, true, nil)
	if err == nil || err.Error() != "p2p.connection_busy" || manager.workbenches[background.PairID] {
		manager.mu.Unlock()
		t.Fatal("background retry stole the explicit waiter's next reservation", err)
	}
	manager.mu.Unlock()
	select {
	case result := <-done:
		t.Fatal("failed ready notification released ownership before cleanup", result.err)
	default:
	}
	manager.finish(background.PairID, background)
	select {
	case result := <-done:
		if result.err != nil || result.connection == nil || result.connection.prepare.Generation != 2 || !result.connection.requestWorkbench || result.connection.resumeWorkbench {
			t.Fatal("joined cleanup did not admit the original explicit request", result.err)
		}
		manager.finish(background.PairID, result.connection)
	case <-manager.ctx.Done():
		t.Fatal("failed candidate cleanup did not release its manual successor")
	}
}

func TestManualWorkbenchDisconnectCannotResurrectWaitingIntent(t *testing.T) {
	manager, background := backgroundManualFixture(t)
	done, _ := startManualReservation(t, manager, background.PairID, 2)
	manager.mu.Lock()
	waiter := manager.manualWaiters[background.PairID]
	manager.mu.Unlock()
	// Disconnect clears intent under manager.mu, then reaches noteStop outside
	// it. Hold that exact second phase while the old owner finishes cleanup.
	background.diagnostic.mu.Lock()
	disconnected := make(chan error, 1)
	go func() { disconnected <- manager.Disconnect(background.PairID) }()
	select {
	case <-waiter.cancelled:
	case <-manager.ctx.Done():
		background.diagnostic.mu.Unlock()
		t.Fatal("disconnect did not atomically invalidate its deferred owner")
	}
	manager.finish(background.PairID, background)
	result := <-done
	if result.connection != nil || result.err == nil || result.err.Error() != "p2p.connection_cancelled" || manager.WorkbenchRequested(background.PairID) {
		background.diagnostic.mu.Unlock()
		t.Fatal("cancelled click restored intent during disconnect cleanup", result.err)
	}
	background.diagnostic.mu.Unlock()
	if err := <-disconnected; err != nil {
		t.Fatal(err)
	}
}

func TestManualWorkbenchWaitingRejectsChangedScopeAndOriginalGeneration(t *testing.T) {
	for _, scenario := range []string{"pin_revision", "account_logout_relogin", "subscription", "stale_generation", "pair_retirement"} {
		t.Run(scenario, func(t *testing.T) {
			manager, background := backgroundManualFixture(t)
			done, _ := startManualReservation(t, manager, background.PairID, 2)
			want := "p2p.pair_unauthorized"
			switch scenario {
			case "pin_revision":
				manager.mu.Lock()
				pin := manager.pins[background.PairID]
				manager.mu.Unlock()
				pin.Pair.Revision++
				if err := manager.Pin(pin); err != nil {
					t.Fatal(err)
				}
			case "account_logout_relogin":
				manager.mu.Lock()
				pin := manager.pins[background.PairID]
				manager.retireAccountScopeLocked("")
				manager.accountUserID, manager.candidatesActive = pin.Initiator.UserID, true
				manager.pins[background.PairID] = pin
				manager.mu.Unlock()
				want = "p2p.user_unauthorized"
			case "subscription":
				manager.mu.Lock()
				owner := manager.signals
				owner.mu.Lock()
				replacement := candidateSubscriptionFor(manager.config.CoreInstanceID)
				owner.active = replacement
				owner.mu.Unlock()
				manager.mu.Unlock()
				defer replacement.Close()
				want = "p2p.registration_stale"
			case "stale_generation":
				manager.mu.Lock()
				manager.generations[background.PairID] = 3
				manager.mu.Unlock()
				want = "p2p.stale_generation"
			case "pair_retirement":
				if err := manager.revokeExpected(background.PairID, ""); err != nil {
					t.Fatal(err)
				}
				want = "p2p.pair_revoked"
			}
			manager.finish(background.PairID, background)
			select {
			case result := <-done:
				if result.connection != nil || result.err == nil || result.err.Error() != want || manager.WorkbenchRequested(background.PairID) {
					t.Fatal("stale waiter admitted a new explicit candidate", result.err, want)
				}
			case <-manager.ctx.Done():
				t.Fatal("stale waiter retained its deferred reservation")
			}
		})
	}
}

func TestManualWorkbenchDoesNotJoinAnotherExplicitOwnerOrWaitingClick(t *testing.T) {
	manager, background := backgroundManualFixture(t)
	done, cancel := startManualReservation(t, manager, background.PairID, 2)
	if _, err := manager.reserveConnectCandidate(context.Background(), background.PairID, 3, true, false); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("second click replaced the original explicit waiter", err)
	}
	cancel()
	if result := <-done; result.err != context.Canceled {
		t.Fatal(result.err)
	}
	manager.mu.Lock()
	background.requestWorkbench, background.resumeWorkbench = true, false
	manager.mu.Unlock()
	if _, err := manager.reserveConnectCandidate(context.Background(), background.PairID, 4, true, false); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("second click borrowed an already explicit owner", err)
	}
	if background.prepare.Generation != 1 || !protocol.ValidNonce(background.prepare.AttemptID) || len(manager.manualWaiters) != 0 {
		t.Fatal("rejection relabeled or replaced the current explicit owner")
	}
}

func TestManualWorkbenchWaitsBehindResumeWithoutUpgradingItsNegotiation(t *testing.T) {
	manager, background := backgroundManualFixture(t)
	manager.mu.Lock()
	manager.workbenches[background.PairID] = true
	background.requestWorkbench, background.resumeWorkbench = true, true
	manager.mu.Unlock()
	done, _ := startManualReservation(t, manager, background.PairID, 2)
	manager.finish(background.PairID, background)
	select {
	case result := <-done:
		if result.err != nil || result.connection == nil || !result.connection.requestWorkbench || result.connection.resumeWorkbench || result.connection.prepare.Generation != 2 || !background.resumeWorkbench {
			t.Fatal("explicit click upgraded a borrowed resume negotiation", result.err)
		}
		manager.finish(background.PairID, result.connection)
	case <-manager.ctx.Done():
		t.Fatal("retained workbench resume discarded its waiting explicit click")
	}
}

func (ctx *manualWaitContext) Done() <-chan struct{} {
	ctx.once.Do(func() { close(ctx.waiting) })
	return ctx.Context.Done()
}

func TestManualWorkbenchCancellationDoesNotCancelBorrowedBackgroundOwner(t *testing.T) {
	manager, _, _ := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	background, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.finish(background.PairID, background)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := &manualWaitContext{Context: ctx, waiting: make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, err := manager.Connect(observed, pin.Pair.PairID, 2, true); done <- err }()
	select {
	case err := <-done:
		t.Fatal("manual workbench request was discarded before waiting for its background owner", err)
	case <-observed.waiting:
	case <-manager.ctx.Done():
		t.Fatal("manual workbench request did not establish a cancellable wait")
	}
	cancel()
	if err := <-done; err != context.Canceled {
		t.Fatal("manual waiter cancellation lost its original result", err)
	}
	if background.ctx.Err() != nil || background.cancellationRequested() || manager.candidates[background.PairID] != background || manager.WorkbenchRequested(background.PairID) {
		t.Fatal("cancelling a borrowed wait mutated the background owner or admitted a workbench")
	}
}
