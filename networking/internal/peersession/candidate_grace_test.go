package peersession

import (
	"net/http"
	"testing"
)

func TestCandidateGraceCoalescedRecoveryCancelsBeforeProjection(t *testing.T) {
	manager, old, _ := liveCandidateHandoffFixture(t, http.NotFoundHandler())
	manager.mu.Lock()
	delete(manager.candidates, old.PairID)
	manager.sessions[old.PairID] = old
	old.promoted = true
	old.result.State.Stage = "ready"
	old.result.State.RuntimeGeneration = 1
	manager.mu.Unlock()
	candidate, err := manager.reserveCandidate(old.PairID, old.lease.Generation+1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	// The reservation captured disconnected before the observer received its
	// coalesced notification; the projection never changed from ready.
	candidate.predecessorWasSuspended = true
	manager.transportChanged(old)
	if !candidate.cancellationRequested() {
		t.Fatal("coalesced recovery lost cancellation while the primary projection was already ready")
	}
	manager.finish(candidate.PairID, candidate)
}
