package peersession

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestCandidatePreparationProjectsItsRealReservedIdentity(t *testing.T) {
	manager, _, _ := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 7, false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.finish(connection.PairID, connection)
	state, err := manager.CurrentState(connection.PairID)
	if err != nil || state.PairID != connection.PairID || state.AttemptID != connection.prepare.AttemptID || state.Generation != 7 || state.Stage != "punching" {
		t.Fatal("preparation did not expose its real reserved operation", state, err)
	}
	if !manager.OwnsState(state) {
		t.Fatal("reserved preparation state lost its current owner")
	}
	state.Stage = "ready"
	state.RuntimeGeneration = 1
	if manager.OwnsState(state) {
		t.Fatal("unsigned preparation identity authorized a ready workbench")
	}
}

func TestCandidatePreparationCannotReplaceExistingPrimaryProjection(t *testing.T) {
	manager, _, _ := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	primary := newSession(manager.ctx)
	primary.PairID = pin.Pair.PairID
	primary.lease = protocol.Lease{AttemptID: protocol.NewNonce(), Generation: 3}
	primary.result.State = State{PairID: primary.PairID, AttemptID: primary.lease.AttemptID, Generation: 3, Stage: "suspended"}
	manager.sessions[primary.PairID] = primary
	defer manager.finish(primary.PairID, primary)
	candidate, err := manager.reserveCandidate(primary.PairID, 4, false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.finish(candidate.PairID, candidate)
	state, err := manager.CurrentState(primary.PairID)
	if err != nil || state != primary.result.State || manager.OwnsState(candidate.result.State) || !manager.OwnsState(state) {
		t.Fatal("preparation replaced an unpromoted primary's live truth", state, err)
	}
	var emitted []State
	manager.emit = func(state State) { emitted = append(emitted, state) }
	manager.emitCurrent(candidate.result.State)
	if len(emitted) != 0 {
		t.Fatal("unsigned candidate published over the existing primary", emitted)
	}
}

func TestCandidateFirstPrepareRateLimitAndExactAbsenceReturnsToBackoff(t *testing.T) {
	var fence protocol.RegistrationFence
	var prepareCalls, stateCalls atomic.Int32
	var attempt string
	manager, current, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: protocol.NewNonce(), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			var request protocol.PrepareCandidate
			json.NewDecoder(r.Body).Decode(&request)
			attempt = request.AttemptID
			prepareCalls.Add(1)
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
		case "/v2/candidates/state":
			var request protocol.CandidateStateRequest
			json.NewDecoder(r.Body).Decode(&request)
			if request.AttemptID != attempt || request.Registration != fence {
				t.Error("absence read changed its original attempt or registration")
			}
			stateCalls.Add(1)
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.attempt_not_found"})
		default:
			t.Errorf("rate limited prepare dispatched an unrelated endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	fence = current
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.finish(connection.PairID, connection)
	err = manager.prepareCandidate(connection)
	if err == nil || err.Error() != "p2p.rate_limited" || prepareCalls.Load() != 1 || stateCalls.Load() != 1 || connection.ticket != nil {
		t.Fatal("proven non-admission did not return the original rate limit", err, prepareCalls.Load(), stateCalls.Load())
	}
}

func TestCandidateUnknownPrepareCannotBeErasedByLaterRateLimitAndAbsence(t *testing.T) {
	var fence protocol.RegistrationFence
	var prepareCalls atomic.Int32
	secondAbsence := make(chan struct{})
	var once sync.Once
	manager, current, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: protocol.NewNonce(), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			if prepareCalls.Add(1) == 1 {
				w.Write([]byte(`{"version":1}`)) // A malformed reply may follow durable admission.
			} else {
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
			}
		case "/v2/candidates/state":
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.attempt_not_found"})
			if prepareCalls.Load() >= 2 {
				once.Do(func() { close(secondAbsence) })
			}
		default:
			http.NotFound(w, r)
		}
	}))
	fence = current
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.finish(connection.PairID, connection)
	done := make(chan error, 1)
	go func() { done <- manager.prepareCandidate(connection) }()
	select {
	case <-secondAbsence:
	case <-manager.ctx.Done():
		t.Fatal("did not reach the later proven rate-limited response")
	}
	manager.cancel()
	if err := <-done; err != context.Canceled {
		t.Fatal("later rejection erased the original unknown admission", err)
	}
	if manager.candidates[connection.PairID] != connection || connection.prepare == nil {
		t.Fatal("unknown admission discarded its original reservation")
	}
}

func TestCandidateRateLimitCannotBorrowAbsenceFromReplacementFence(t *testing.T) {
	var manager *Manager
	var fence protocol.RegistrationFence
	var prepares atomic.Int32
	secondPrepare := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	manager, fence, _ = controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: protocol.NewNonce(), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			if prepares.Add(1) == 1 {
				manager.mu.Lock()
				owner := manager.signals
				owner.mu.Lock()
				replacement := candidateSubscriptionFor(manager.config.CoreInstanceID)
				owner.active = replacement
				owner.mu.Unlock()
				manager.mu.Unlock()
				t.Cleanup(replacement.Close)
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
			} else {
				close(secondPrepare)
				<-release
			}
		case "/v2/candidates/state":
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.attempt_not_found"})
		default:
			http.NotFound(w, r)
		}
	}))
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.finish(connection.PairID, connection)
	done := make(chan error, 1)
	go func() { done <- manager.prepareCandidate(connection) }()
	select {
	case <-secondPrepare:
	case err := <-done:
		t.Fatal("replacement registration's absence erased the original dispatch", err)
	case <-manager.ctx.Done():
		t.Fatal("exact original operation was not retained after fence change")
	}
	manager.cancel()
	if err := <-done; err != context.Canceled {
		t.Fatal("replacement scope relabeled the original result", err)
	}
}

func TestCandidateErrorCodeAloneCannotProvePrepareNonAdmission(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		prepareStatus int
		stateStatus   int
	}{
		{"prepare_503_same_code", http.StatusServiceUnavailable, http.StatusNotFound},
		{"state_503_same_code", http.StatusTooManyRequests, http.StatusServiceUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var fence protocol.RegistrationFence
			var prepares atomic.Int32
			replayed, release := make(chan struct{}), make(chan struct{})
			defer close(release)
			manager, current, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/links/state":
					json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: protocol.NewNonce(), PeerCapabilities: []string{protocol.CapabilityCandidate}})
				case "/v2/candidates/prepare":
					if prepares.Add(1) > 1 {
						close(replayed)
						<-release
						return
					}
					w.WriteHeader(scenario.prepareStatus)
					json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
				case "/v2/candidates/state":
					w.WriteHeader(scenario.stateStatus)
					json.NewEncoder(w).Encode(map[string]string{"code": "p2p.attempt_not_found"})
				default:
					http.NotFound(w, r)
				}
			}))
			fence = current
			_, pin := pinFixture()
			connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.finish(connection.PairID, connection)
			done := make(chan error, 1)
			go func() { done <- manager.prepareCandidate(connection) }()
			select {
			case <-replayed:
			case err := <-done:
				t.Fatal("HTTP status was replaced by its same-named error body", err)
			case <-manager.ctx.Done():
				t.Fatal("uncertain prepare did not retain its exact operation")
			}
			manager.cancel()
			if err := <-done; err != context.Canceled {
				t.Fatal("uncertain HTTP response became proven non-admission", err)
			}
		})
	}
}
