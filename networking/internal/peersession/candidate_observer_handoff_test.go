package peersession

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestCandidateHandoffUnknownObserverCancelTransfersExactOwner(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var ticket protocol.CandidateTicket
	var cancels, reads atomic.Int32
	manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/candidates/cancel":
			var action protocol.CandidateAction
			if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
				t.Error("observer Cancel changed exact ticket")
			}
			cancels.Add(1)
			close(entered)
			// The server has applied Cancel, but its HTTP reply is still unknown.
			select {
			case <-r.Context().Done():
			case <-release:
			}
		case "/v2/candidates/state":
			var request protocol.CandidateStateRequest
			if json.NewDecoder(r.Body).Decode(&request) != nil || request.AttemptID != ticket.Lease.AttemptID || request.UserID != ticket.Lease.UserID || request.NetworkID != ticket.Lease.NetworkID || request.PairID != ticket.Lease.PairID {
				t.Error("handoff queried another mutation")
			}
			reads.Add(1)
			state := pendingCandidateState(ticket)
			state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
			json.NewEncoder(w).Encode(state)
		default:
			t.Error("unknown Cancel dispatched unrelated work", r.URL.Path)
		}
	}))
	t.Cleanup(func() { close(release) })
	ticket = signed
	connection.requestCancel()
	observer := manager.startCandidateDecisionObserver(connection)
	select {
	case <-entered:
	case <-manager.ctx.Done():
		t.Fatal("early observer did not dispatch Cancel")
	}
	if _, err := manager.reserveCandidate(connection.PairID, 2, false, false); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("unknown Cancel released candidate slot", err)
	}
	unknown := observer.stop()
	if !unknown || connection.ctx.Err() != nil || manager.ctx.Err() != nil {
		t.Fatal("observer dropped its unknown Cancel or cancelled shared owner")
	}
	if err := manager.resolveCandidateCancellationAfterObserver(connection, unknown); err == nil || err.Error() != "p2p.candidate_cancelled" {
		t.Fatal("main owner did not resolve dispatched Cancel", err)
	}
	if cancels.Load() != 1 || reads.Load() != 1 || *connection.ticket != ticket || manager.candidates[connection.PairID] != connection {
		t.Fatal("handoff replayed Cancel before fresh State or changed ticket/deadline")
	}
}

func TestCandidateHandoffRunCandidateJoinsObserverOnEveryExit(t *testing.T) {
	for _, phase := range []string{"wait-ready-error", "establish-error", "cancel-wait", "cancel-before-wait", "manager-close"} {
		t.Run(phase, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var enterOnce, releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			var ticket protocol.CandidateTicket
			var stateActive, afterReturn atomic.Int32
			var returned, cancelled atomic.Bool
			manager, connection, signed, remote := candidateHandoffTransportFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if returned.Load() && r.URL.Path != "/v2/end" {
					afterReturn.Add(1)
				}
				switch r.URL.Path {
				case "/v2/candidates/state":
					io.Copy(io.Discard, r.Body)
					if cancelled.Load() {
						state := pendingCandidateState(ticket)
						state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
						json.NewEncoder(w).Encode(state)
						return
					}
					if phase == "cancel-before-wait" {
						// The observer may conservatively transfer an interrupted
						// dispatch that never reached this server. Fresh readback must
						// truthfully report pending so its owner can replay Cancel.
						json.NewEncoder(w).Encode(pendingCandidateState(ticket))
						return
					}
					stateActive.Add(1)
					defer stateActive.Add(-1)
					enterOnce.Do(func() { close(entered) })
					select {
					case <-r.Context().Done():
						return
					case <-release:
					}
					state := pendingCandidateState(ticket)
					json.NewEncoder(w).Encode(state)
				case "/v2/candidates/cancel":
					var action protocol.CandidateAction
					if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
						t.Error("exit cancellation changed immutable ticket")
					}
					cancelled.Store(true)
					state := pendingCandidateState(ticket)
					state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
					json.NewEncoder(w).Encode(state)
				case "/v2/end":
					var end protocol.EndCandidate
					if json.NewDecoder(r.Body).Decode(&end) != nil || end.Ticket != ticket {
						t.Error("exit End changed immutable ticket")
					}
					json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: ticket.Lease.AttemptID, Generation: ticket.Lease.Generation, Ended: true, Reason: end.Reason})
				default:
					t.Error("exit generated unrelated control operation", r.URL.Path)
				}
			}), phase == "establish-error")
			t.Cleanup(unblock)
			ticket = signed
			if phase == "cancel-before-wait" {
				connection.requestCancel()
			} else {
				connection.notify()
			}
			done := make(chan struct{})
			go func() { manager.runCandidate(connection, true); returned.Store(true); close(done) }()
			if phase != "cancel-before-wait" {
				select {
				case <-entered:
				case <-manager.ctx.Done():
					t.Fatal("exit fixture did not establish blocked early State")
				}
			}
			var closed chan struct{}
			switch phase {
			case "wait-ready-error":
				connection.transport.Close()
			case "establish-error":
				remote.Close()
			case "cancel-wait":
				connection.requestCancel()
				unblock()
			case "manager-close":
				closed = make(chan struct{})
				go func() { manager.Close(); close(closed) }()
			}
			ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("candidate exit did not join its early observer")
			}
			if closed != nil {
				select {
				case <-closed:
				case <-ctx.Done():
					t.Fatal("Manager.Close did not join candidate")
				}
			}
			manager.endWait.Wait()
			if phase != "manager-close" && !cancelled.Load() {
				t.Fatal("exit abandoned authoritative cancellation")
			}
			if *connection.ticket != ticket || afterReturn.Load() != 0 {
				t.Fatal("exit reused owner after join or changed immutable deadline")
			}
			select {
			case <-connection.done:
			default:
				t.Fatal("runCandidate returned before exact session finish")
			}
		})
	}
}
