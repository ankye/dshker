package peersession

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func preparedCandidateFor(t *testing.T, handler http.Handler) (*Manager, *session, protocol.CandidateTicket) {
	t.Helper()
	manager, fence, key := controlCandidateManager(t, handler)
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	request := *connection.prepare
	request.Registration, request.ToCoreInstanceID = fence, protocol.NewNonce()
	connection.prepare = &request
	ticket := signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
	if err := manager.installCandidateTicket(connection, ticket); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.cancel(); manager.endWait.Wait(); manager.finish(connection.PairID, connection) })
	return manager, connection, ticket
}

func pendingCandidateState(ticket protocol.CandidateTicket) protocol.CandidateState {
	return protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: ticket.Lease}, LatestLease: ticket.Lease}
}

func TestReadyUnknownReplyKeepsSameTicketUntilOwnReadiness(t *testing.T) {
	for _, kind := range []string{"rate-limited", "malformed", "bad-decision", "missing-own-ready"} {
		t.Run(kind, func(t *testing.T) {
			var ticket protocol.CandidateTicket
			var ready, reads atomic.Int32
			manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/candidates/ready":
					var action protocol.CandidateAction
					if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
						t.Error("Ready replay changed immutable ticket")
					}
					if ready.Add(1) == 1 {
						switch kind {
						case "rate-limited":
							w.WriteHeader(429)
							json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
							return
						case "malformed":
							w.Write([]byte(`{"ticket":`))
							return
						case "bad-decision":
							bad := pendingCandidateState(ticket)
							bad.Decision.Reason = "invalid-pending-reason"
							json.NewEncoder(w).Encode(bad)
							return
						case "missing-own-ready":
							json.NewEncoder(w).Encode(pendingCandidateState(ticket))
							return
						}
					}
					state := pendingCandidateState(ticket)
					state.FromReady = true
					json.NewEncoder(w).Encode(state)
				case "/v2/candidates/state":
					reads.Add(1)
					state := pendingCandidateState(ticket)
					state.FromReady = kind != "rate-limited" && kind != "missing-own-ready"
					json.NewEncoder(w).Encode(state)
				default:
					t.Error("Ready uncertainty dispatched unrelated operation", r.URL.Path)
				}
			}))
			ticket = signed
			if err := manager.readyCandidate(connection); err != nil {
				t.Fatal("unknown Ready released resources", err)
			}
			want := int32(1)
			if kind == "rate-limited" || kind == "missing-own-ready" {
				want = 2
			}
			if ready.Load() != want || reads.Load() != 1 || manager.candidates[connection.PairID] != connection || *connection.ticket != ticket {
				t.Fatal("Ready advanced without exact own-readiness evidence")
			}
		})
	}
}

func TestCancelUnknownReceiptContinuesSameTicketResolution(t *testing.T) {
	for _, kind := range []string{"rate-limited", "malformed", "bad-state"} {
		t.Run(kind, func(t *testing.T) {
			var ticket protocol.CandidateTicket
			var calls, reads atomic.Int32
			cancelled := func() protocol.CandidateState {
				state := pendingCandidateState(ticket)
				state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
				return state
			}
			manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/candidates/cancel":
					var action protocol.CandidateAction
					if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
						t.Error("Cancel replay changed ticket")
					}
					if calls.Add(1) == 1 {
						if kind == "rate-limited" {
							w.WriteHeader(429)
							json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
							return
						}
						if kind == "malformed" {
							w.Write([]byte(`{"state":`))
							return
						}
						bad := cancelled()
						bad.Ticket.Signature = "invalid"
						json.NewEncoder(w).Encode(bad)
						return
					}
					json.NewEncoder(w).Encode(cancelled())
				case "/v2/candidates/state":
					reads.Add(1)
					if kind == "rate-limited" {
						json.NewEncoder(w).Encode(pendingCandidateState(ticket))
						return
					}
					json.NewEncoder(w).Encode(cancelled())
				default:
					t.Error("Cancel uncertainty dispatched unrelated operation", r.URL.Path)
				}
			}))
			ticket = signed
			if err := manager.resolveCandidateCancellation(connection); err == nil || err.Error() != "p2p.candidate_cancelled" {
				t.Fatal("Cancel did not retain authoritative terminal reason", err)
			}
			want := int32(1)
			if kind == "rate-limited" {
				want = 2
			}
			if calls.Load() != want || reads.Load() != 1 || manager.candidates[connection.PairID] != connection || *connection.ticket != ticket {
				t.Fatal("Cancel discarded its id before authoritative resolution")
			}
		})
	}
}

func TestEndRateLimitKeepsLightweightOwnerAfterSessionFinish(t *testing.T) {
	var ticket protocol.CandidateTicket
	var calls atomic.Int32
	manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/end":
			var request protocol.EndCandidate
			if json.NewDecoder(r.Body).Decode(&request) != nil || request.Ticket != ticket {
				t.Error("End cleanup changed exact ticket")
			}
			if calls.Add(1) == 1 {
				w.WriteHeader(429)
				json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
				return
			}
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: ticket.Lease.AttemptID, Generation: ticket.Lease.Generation, Ended: true, Reason: request.Reason})
		case "/v2/candidates/state":
			json.NewEncoder(w).Encode(pendingCandidateState(ticket))
		default:
			t.Error("End cleanup used unrelated operation", r.URL.Path)
		}
	}))
	ticket = signed
	manager.endCandidate(connection, "failed")
	manager.finish(connection.PairID, connection)
	manager.mu.Lock()
	job := manager.endJobs[ticket.Lease.AttemptID]
	manager.mu.Unlock()
	if job == nil || job.ticket != ticket {
		t.Fatal("local done forgot unknown server cleanup")
	}
	select {
	case <-job.done:
	case <-time.After(2 * time.Second):
		t.Fatal("same-ticket cleanup did not recover after transient 429")
	}
	if calls.Load() != 2 {
		t.Fatal("cleanup changed identity or retried unexpectedly", calls.Load())
	}
}

func TestManagerCloseCancelsAndJoinsUnknownEndOwner(t *testing.T) {
	var ticket protocol.CandidateTicket
	manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/candidates/state" {
			json.NewEncoder(w).Encode(pendingCandidateState(ticket))
			return
		}
		w.WriteHeader(429)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
	}))
	ticket = signed
	manager.endCandidate(connection, "disconnect")
	manager.finish(connection.PairID, connection)
	manager.mu.Lock()
	job := manager.endJobs[ticket.Lease.AttemptID]
	manager.mu.Unlock()
	if job == nil {
		t.Fatal("cleanup owner absent before Close")
	}
	manager.Close()
	select {
	case <-job.done:
	default:
		t.Fatal("Close returned before End owner joined")
	}
}
