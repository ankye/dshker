package peersession

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/pion/turn/v5"
)

// Local TLS, signed complete SDP and real Pion resources. Historical committed
// State is supplied by the TLS control fixture; this is not physical/WSS proof.
type inboundCommittedStartup struct {
	manager                   *Manager
	active                    *candidateSubscription
	old, next                 protocol.CandidateTicket
	state                     protocol.CandidateState
	oldOwner                  *session
	source                    *peer.Transport
	offer                     protocol.Signal
	pion                      bool
	oldTURN, oldTURNRelease   chan struct{}
	nextTURN, nextRelease     chan struct{}
	oldState, oldStateRelease chan struct{}
	read, readRelease         chan struct{}
	oldEnd, oldEndRelease     chan struct{}
	oldOnce, nextOnce         sync.Once
	stateOnce, readOnce       sync.Once
	endOnce                   sync.Once
	oldUnblock, nextUnblock   sync.Once
	stateUnblock, readUnblock sync.Once
	endUnblock                sync.Once
	turnCalls, stateCalls     atomic.Int32
}

func newInboundCommittedStartup(t *testing.T, pion bool) *inboundCommittedStartup {
	t.Helper()
	f := &inboundCommittedStartup{pion: pion, oldTURN: make(chan struct{}), oldTURNRelease: make(chan struct{}),
		nextTURN: make(chan struct{}), nextRelease: make(chan struct{}), oldState: make(chan struct{}),
		oldStateRelease: make(chan struct{}), read: make(chan struct{}), readRelease: make(chan struct{}),
		oldEnd: make(chan struct{}), oldEndRelease: make(chan struct{})}
	manager, fence, key := controlCandidateManager(t, http.HandlerFunc(f.serve))
	f.manager, f.active = manager, manager.signals.active.(*candidateSubscription)
	localPublic, localKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	remotePublic, remoteKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, pin := pinFixture()
	manager.config.PrivateKey, manager.config.Device.PublicKey = localKey, localPublic
	pin.Initiator.PublicKey, pin.Target.PublicKey = localPublic, remotePublic
	manager.pins[pin.Pair.PairID] = pin
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stun, err := turn.NewServer(turn.ServerConfig{Realm: "dshker.committed-startup.test",
		AuthHandler: func(*turn.RequestAttributes) (string, []byte, bool) { return "", nil, false },
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: socket, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
			RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
		}}}})
	if err != nil {
		socket.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { stun.Close() })
	manager.config.Endpoints.STUNAddress = socket.LocalAddr().String()
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(), UserID: pin.Initiator.UserID,
		NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID, Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	remoteCore := protocol.NewNonce()
	f.old = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	request.PreviousAttemptID, request.PreviousGeneration = request.AttemptID, request.Generation
	request.AttemptID, request.Generation = protocol.NewNonce(), 2
	f.next = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	f.state = pendingCandidateState(f.old)
	f.state.FromReady, f.state.ToReady = true, true
	f.state.Decision.Status, f.state.Decision.DecidedAt = "committed", time.Now().Unix()
	f.state.CurrentActiveAttemptID, f.state.CurrentActiveGeneration = f.old.Lease.AttemptID, f.old.Lease.Generation
	lease := f.next.Lease
	f.source, err = peer.NewTransport(manager.ctx, peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID,
		STUNAddress: socket.LocalAddr().String(), LocalDeviceID: lease.FromDeviceID, PeerDeviceID: lease.ToDeviceID,
		PrivateKey: remoteKey, PeerKey: localPublic, ServiceKey: manager.config.Authority.PublicKey,
		Scope: protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation,
			FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}, Revision: lease.Revision, Lease: lease, Ticket: &f.next})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.oldUnblock.Do(func() { close(f.oldTURNRelease) })
		f.nextUnblock.Do(func() { close(f.nextRelease) })
		f.stateUnblock.Do(func() { close(f.oldStateRelease) })
		f.readUnblock.Do(func() { close(f.readRelease) })
		f.endUnblock.Do(func() { close(f.oldEndRelease) })
		manager.Close()
		f.source.Close()
	})
	f.offer, err = f.source.Offer(manager.ctx)
	if err != nil {
		t.Fatal(err)
	}
	manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.old})
	manager.mu.Lock()
	f.oldOwner = manager.inboundCandidates[pin.Pair.PairID]
	manager.mu.Unlock()
	if f.oldOwner == nil || !inboundRetirementAwait(t, f.oldTURN, "historical Prepared reached actual TURN admission") {
		t.Fatal("missing historical receiver-owned startup")
	}
	if pion && !inboundRetirementAwait(t, f.oldState, "actual Pion runner's first State read") {
		t.FailNow()
	}
	manager.mu.Lock()
	transport := f.oldOwner.transport
	f.oldOwner.mu.Lock()
	mux := f.oldOwner.mux
	f.oldOwner.mu.Unlock()
	manager.mu.Unlock()
	if (transport != nil) != pion || mux != nil || f.oldOwner.ctx.Err() != nil {
		t.Fatal("startup test did not reach its exact nil-transport/no-staged-mux boundary")
	}
	if transport != nil {
		select {
		case <-transport.Done():
			t.Fatal("no-mux test accidentally used a closed transport")
		default:
		}
	}
	return f
}

func (f *inboundCommittedStartup) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1/turn-credentials":
		if f.turnCalls.Add(1) == 1 {
			f.oldOnce.Do(func() { close(f.oldTURN) })
			if !f.pion {
				select {
				case <-r.Context().Done():
					return
				case <-f.oldTURNRelease:
				}
			}
		} else {
			f.nextOnce.Do(func() { close(f.nextTURN) })
			select {
			case <-r.Context().Done():
				return
			case <-f.nextRelease:
			}
		}
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.relay_unconfigured"})
	case "/v2/candidates/state":
		var request protocol.CandidateStateRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.AttemptID != f.old.Lease.AttemptID || request.Registration != f.active.fence {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if f.stateCalls.Add(1) == 1 && f.pion {
			f.stateOnce.Do(func() { close(f.oldState) })
			select {
			case <-r.Context().Done():
				return
			case <-f.oldStateRelease:
			}
		} else {
			f.readOnce.Do(func() { close(f.read) })
			select {
			case <-r.Context().Done():
				return
			case <-f.readRelease:
			}
		}
		json.NewEncoder(w).Encode(f.state)
	case "/v2/end":
		var end protocol.EndCandidate
		if json.NewDecoder(r.Body).Decode(&end) != nil || end.Reason != "failed" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if end.Ticket == f.old {
			f.endOnce.Do(func() { close(f.oldEnd) })
			select {
			case <-r.Context().Done():
				return
			case <-f.oldEndRelease:
			}
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: f.old.Lease.AttemptID, Generation: f.old.Lease.Generation,
				Reason: end.Reason, CurrentActiveAttemptID: f.old.Lease.AttemptID, CurrentActiveGeneration: f.old.Lease.Generation})
		} else if end.Ticket == f.next {
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: f.next.Lease.AttemptID, Generation: f.next.Lease.Generation, Reason: end.Reason, Ended: true})
		} else {
			w.WriteHeader(http.StatusBadRequest)
		}
	default:
		http.NotFound(w, r)
	}
}

func TestInboundAdmissionCurrentCommittedStartupPreservesOrderedSuccessor(t *testing.T) {
	for _, pion := range []bool{false, true} {
		name := "held-turn-nil-transport"
		if pion {
			name = "pion-without-staged-mux"
		}
		t.Run(name, func(t *testing.T) {
			f := newInboundCommittedStartup(t, pion)
			if err := f.manager.promoteCandidate(f.oldOwner, f.state, false); err == nil || f.oldOwner.ctx.Err() != nil {
				t.Fatal("ordinary promotion inferred startup death without an exact queued admission")
			}
			f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.next})
			f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "signal", Ticket: f.next, Signal: f.offer})
			f.manager.mu.Lock()
			job := f.manager.inboundAdmissions[f.oldOwner.PairID]
			f.manager.mu.Unlock()
			if job == nil || !inboundRetirementAwait(t, f.read, "successor's exact historical committed State read") {
				t.Fatal("missing queued historical owner")
			}
			f.readUnblock.Do(func() { close(f.readRelease) })
			if !inboundRetirementAwait(t, job.done, "strict current committed startup barrier") {
				return
			}
			f.manager.mu.Lock()
			_, retired := f.manager.retiring[f.oldOwner]
			preserved := f.manager.inboundCandidates[f.oldOwner.PairID] == job.connection && *job.connection.ticket == f.next && len(job.connection.signalInbox) == 1
			f.manager.mu.Unlock()
			if job.err != nil || !retired || !preserved || f.oldOwner.ctx.Err() == nil || f.oldOwner.promoted {
				t.Errorf("current committed startup swallowed its ordered successor: error=%v retired=%t successor=%t", job.err, retired, preserved)
				return
			}
			if !inboundRetirementAwait(t, f.oldEnd, "retired exact startup retained End ownership") || !inboundRetirementAwait(t, f.nextTURN, "same queued successor reached its own TURN startup") {
				return
			}
			f.endUnblock.Do(func() { close(f.oldEndRelease) })
			if !inboundRetirementAwait(t, f.oldOwner.done, "old startup joined without cancelling the successor CAS") {
				return
			}
			f.manager.mu.Lock()
			intact := f.manager.inboundCandidates[f.oldOwner.PairID] == job.connection
			f.manager.mu.Unlock()
			if !intact {
				t.Fatal("old startup finish deleted its successor")
			}
			f.nextUnblock.Do(func() { close(f.nextRelease) })
			select {
			case answer := <-f.active.sent:
				if answer.AttemptID != f.next.Lease.AttemptID || answer.Generation != f.next.Lease.Generation || answer.Type != "answer" {
					t.Error("startup handoff changed the retained signed offer")
				} else if err := f.source.AcceptAnswer(answer); err != nil {
					t.Error("real source rejected the successor answer", err)
				}
			case <-f.manager.ctx.Done():
				t.Error("retained successor offer was never answered")
			}
		})
	}
}

func TestInboundAdmissionCurrentCommittedRetirementSurvivesOldFinishFirst(t *testing.T) {
	f := newInboundCommittedStartup(t, false)
	entered, release, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	// Hold the existing completion primitive, not a production hook: both real
	// callers may reach complete, but neither can return until cleanup finishes.
	// This gate never publishes ready, retires an owner or calls finish itself.
	go func() {
		defer close(joined)
		f.oldOwner.readyOnce.Do(func() { close(entered); <-release })
	}()
	t.Cleanup(func() { unblock.Do(func() { close(release) }); <-joined })
	if !inboundRetirementAwait(t, entered, "test-owned completion scheduling barrier") {
		return
	}
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.next})
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "signal", Ticket: f.next, Signal: f.offer})
	f.manager.mu.Lock()
	job := f.manager.inboundAdmissions[f.oldOwner.PairID]
	f.manager.mu.Unlock()
	if job == nil || !inboundRetirementAwait(t, f.read, "exact committed State before old finish") {
		t.Fatal("missing exact queued admission")
	}
	f.readUnblock.Do(func() { close(f.readRelease) })
	if !inboundRetirementAwait(t, f.oldEnd, "actual retired startup End request") {
		return
	}
	f.endUnblock.Do(func() { close(f.oldEndRelease) })
	if !inboundRetirementAwait(t, f.oldOwner.done, "actual End readback and old finish before promotion returns") {
		return
	}
	f.manager.mu.Lock()
	_, retired := f.manager.retiring[f.oldOwner]
	stillQueued := f.manager.inboundAdmissions[f.oldOwner.PairID] == job && f.manager.inboundCandidates[f.oldOwner.PairID] == nil
	f.manager.mu.Unlock()
	if retired || !stillQueued || f.oldOwner.ctx.Err() == nil {
		t.Fatal("old cleanup did not finish and erase retiring before admission resumed")
	}
	select {
	case <-job.done:
		t.Fatal("admission returned while its real promotion completion was held")
	default:
	}
	unblock.Do(func() { close(release) })
	<-joined
	if !inboundRetirementAwait(t, job.done, "same admission resumes after old finish") {
		return
	}
	f.manager.mu.Lock()
	preserved := f.manager.inboundCandidates[f.oldOwner.PairID] == job.connection && *job.connection.ticket == f.next && len(job.connection.signalInbox) == 1
	f.manager.mu.Unlock()
	if job.err != nil || !preserved || f.oldOwner.promoted {
		t.Fatalf("completed old cleanup erased exact retirement authority: error=%v successor=%t", job.err, preserved)
	}
	if !inboundRetirementAwait(t, f.nextTURN, "retained successor starts after old finish") {
		return
	}
	f.nextUnblock.Do(func() { close(f.nextRelease) })
	select {
	case answer := <-f.active.sent:
		if answer.AttemptID != f.next.Lease.AttemptID || answer.Generation != f.next.Lease.Generation || answer.Type != "answer" {
			t.Error("old-finish-first handoff changed the retained signed offer")
		} else if err := f.source.AcceptAnswer(answer); err != nil {
			t.Error("real source rejected the successor answer after old finish", err)
		}
	case <-f.manager.ctx.Done():
		t.Error("old-finish-first successor offer was never answered")
	}
}

func TestInboundPreparedDuplicateOfPromotedPrimaryIsIdempotent(t *testing.T) {
	manager, old, ticket, _, active, _ := readyInboundOrderFixture(t, false)
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	manager.mu.Lock()
	promoted := old.promoted && manager.inbound[old.PairID] == old && manager.inboundCandidates[old.PairID] == nil
	before := len(manager.allSessionsLocked())
	manager.mu.Unlock()
	if !promoted {
		t.Fatal("actual connected primary did not pass its original signed commit barrier")
	}
	for range 2 {
		manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate", Ticket: ticket})
	}
	manager.mu.Lock()
	unchanged := manager.inbound[old.PairID] == old && manager.inboundCandidates[old.PairID] == nil &&
		manager.inboundAdmissions[old.PairID] == nil && len(manager.allSessionsLocked()) == before
	manager.mu.Unlock()
	if !unchanged || old.ctx.Err() != nil || !old.promoted || *old.ticket != ticket {
		t.Error("exact-ticket duplicate created a second startup owner for its promoted primary")
	}
}
