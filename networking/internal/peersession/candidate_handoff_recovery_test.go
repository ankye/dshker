package peersession

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func breakHandoffReply(t *testing.T, w http.ResponseWriter, kind string) {
	t.Helper()
	switch kind {
	case "lost":
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		connection.Close()
	case "malformed":
		w.Write([]byte(`{"ticket":`))
	case "429":
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
	}
}

func TestCandidateHandoffUnknownReadyAndCommitRequireFreshState(t *testing.T) {
	for _, operation := range []string{"ready", "commit"} {
		for _, kind := range []string{"lost", "malformed", "429"} {
			t.Run(operation+"/"+kind, func(t *testing.T) {
				var ticket protocol.CandidateTicket
				var ready, commit, reads atomic.Int32
				var committed atomic.Bool
				manager, connection, signed := liveCandidateHandoffFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					state := pendingCandidateState(ticket)
					state.FromReady, state.ToReady = true, true
					if r.URL.Path == "/v2/candidates/state" {
						var request protocol.CandidateStateRequest
						if json.NewDecoder(r.Body).Decode(&request) != nil || request.AttemptID != ticket.Lease.AttemptID || request.UserID != ticket.Lease.UserID || request.NetworkID != ticket.Lease.NetworkID || request.PairID != ticket.Lease.PairID {
							t.Error("unknown action queried a different scope")
						}
						reads.Add(1)
						if committed.Load() {
							state = committedHandoffState(ticket)
						}
						if operation == "ready" && kind == "429" && ready.Load() == 1 {
							state.FromReady = false
						}
					} else {
						var action protocol.CandidateAction
						if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
							t.Error("unknown action changed exact ticket")
						}
						var attempt int32
						switch r.URL.Path {
						case "/v2/candidates/ready":
							attempt = ready.Add(1)
						case "/v2/candidates/commit":
							attempt = commit.Add(1)
							if !(operation == "commit" && kind == "429" && attempt == 1) {
								committed.Store(true)
							}
							state = committedHandoffState(ticket)
						default:
							t.Error("unknown outcome used an unrelated operation", r.URL.Path)
						}
						if r.URL.Path == "/v2/candidates/"+operation && attempt == 1 {
							breakHandoffReply(t, w, kind)
							return
						}
					}
					json.NewEncoder(w).Encode(state)
				}))
				ticket = signed
				observer := manager.startCandidateDecisionObserver(connection)
				observer.stop()
				if err := manager.readyAndResolveCandidate(connection, true); err != nil {
					t.Fatal(err)
				}
				if reads.Load() < 1 || !manager.isPromoted(connection) || *connection.ticket != ticket {
					t.Fatal("unknown dispatch skipped durable readback or changed candidate")
				}
				wantReady, wantCommit := int32(1), int32(1)
				if kind == "429" {
					if operation == "ready" {
						wantReady = 2
					} else {
						wantCommit = 2
					}
				}
				if ready.Load() != wantReady || commit.Load() != wantCommit {
					t.Fatal("unknown action replayed outside its same-ticket owner", ready.Load(), commit.Load())
				}
			})
		}
	}
}

func TestCandidateHandoffUnknownCancelRequiresFreshState(t *testing.T) {
	for _, kind := range []string{"lost", "malformed", "429"} {
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
						t.Error("Cancel changed exact ticket")
					}
					if calls.Add(1) == 1 {
						breakHandoffReply(t, w, kind)
						return
					}
				case "/v2/candidates/state":
					reads.Add(1)
					if kind == "429" {
						json.NewEncoder(w).Encode(pendingCandidateState(ticket))
						return
					}
				default:
					t.Error("Cancel created unrelated work", r.URL.Path)
				}
				json.NewEncoder(w).Encode(cancelled())
			}))
			ticket = signed
			if err := manager.resolveCandidateCancellation(connection); err == nil || err.Error() != "p2p.candidate_cancelled" {
				t.Fatal("unknown Cancel did not resolve terminal cause", err)
			}
			if reads.Load() != 1 || *connection.ticket != ticket || manager.candidates[connection.PairID] != connection {
				t.Fatal("unknown Cancel lost exact durable owner")
			}
		})
	}
}

func TestCandidateHandoffCommittedReadyStillReadsCurrentActiveState(t *testing.T) {
	for _, active := range []string{"current", "empty", "other", "generation", "missing-ready"} {
		t.Run(active, func(t *testing.T) {
			var ticket protocol.CandidateTicket
			var reads atomic.Int32
			manager, connection, signed := liveCandidateHandoffFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				state := committedHandoffState(ticket)
				if r.URL.Path == "/v2/candidates/state" {
					reads.Add(1)
					switch active {
					case "empty":
						state.CurrentActiveAttemptID, state.CurrentActiveGeneration = "", 0
					case "other":
						state.CurrentActiveAttemptID = protocol.NewNonce()
					case "generation":
						state.CurrentActiveGeneration++
					case "missing-ready":
						state.ToReady = false
					}
				} else if r.URL.Path != "/v2/candidates/ready" {
					t.Error("historical committed state dispatched a mutation", r.URL.Path)
				}
				json.NewEncoder(w).Encode(state)
			}))
			ticket = signed
			err := manager.readyAndResolveCandidate(connection, true)
			if reads.Load() != 1 || (active == "current") != manager.isPromoted(connection) || (active == "current") != (err == nil) {
				t.Fatal("historical committed receipt replaced current-active authority", reads.Load(), err)
			}
		})
	}
}

func TestCandidateHandoffInitialReceiptIsOneUseAndCancellationWins(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "one-use", true: "cancel-before-consume"}[cancel], func(t *testing.T) {
			var ticket protocol.CandidateTicket
			var reads, commits atomic.Int32
			manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				state := pendingCandidateState(ticket)
				if r.URL.Path == "/v2/candidates/ready" {
					state.FromReady = true
				} else {
					if r.URL.Path == "/v2/candidates/state" {
						reads.Add(1)
					}
					if r.URL.Path == "/v2/candidates/commit" {
						commits.Add(1)
					}
					state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
				}
				json.NewEncoder(w).Encode(state)
			}))
			ticket = signed
			initial, err := manager.readyCandidateReceipt(connection)
			if err != nil || initial == nil {
				t.Fatal("valid pending Ready did not supply its one-use result", err)
			}
			if _, err := manager.reserveCandidate(connection.PairID, 2, false, true); err == nil || err.Error() != "p2p.connection_busy" {
				t.Fatal("receipt released the unique candidate slot", err)
			}
			if cancel {
				connection.requestCancel()
			}
			if err := manager.resolveCandidateReceipt(connection, true, initial); err == nil || err.Error() != "p2p.candidate_cancelled" {
				t.Fatal("one-use resolution did not retain terminal cause", err)
			}
			if commits.Load() != 0 || reads.Load() != map[bool]int32{false: 1, true: 0}[cancel] || *connection.ticket != ticket {
				t.Fatal("initial receipt was reused or cancellation/deadline changed")
			}
		})
	}
}

func TestCandidateHandoffInitialReceiptRequiresCurrentScope(t *testing.T) {
	for _, scope := range []string{"account", "selected-owner", "core", "device", "subscription", "pin", "slot", "ticket", "epoch"} {
		t.Run(scope, func(t *testing.T) {
			var ticket protocol.CandidateTicket
			manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				state := pendingCandidateState(ticket)
				state.FromReady = true
				json.NewEncoder(w).Encode(state)
			}))
			ticket = signed
			initial, err := manager.readyCandidateReceipt(connection)
			if err != nil || initial == nil || !manager.currentReadyReceipt(connection, true, initial) {
				t.Fatal("positive same-call scope did not verify", err)
			}
			switch scope {
			case "account":
				manager.client.SetAccount(protocol.NewID())
			case "selected-owner":
				manager.accountUserID = protocol.NewID()
			case "core":
				manager.config.CoreInstanceID = protocol.NewNonce()
			case "device":
				manager.config.Device.DeviceID = protocol.NewID()
			case "subscription", "epoch":
				next := candidateSubscriptionFor(manager.config.CoreInstanceID)
				if scope == "subscription" {
					next.fence = initial.action.Registration
				}
				manager.signals.mu.Lock()
				manager.signals.active = next
				manager.signals.mu.Unlock()
				t.Cleanup(next.Close)
			case "pin":
				delete(manager.pins, connection.PairID)
			case "slot":
				manager.candidates[connection.PairID] = newSession(manager.ctx)
			case "ticket":
				copy := *connection.ticket
				copy.PrepareDeadline++
				connection.ticket = &copy
			}
			if manager.currentReadyReceipt(connection, true, initial) {
				t.Fatal("stale receipt retained operation authority", scope)
			}
		})
	}
}
