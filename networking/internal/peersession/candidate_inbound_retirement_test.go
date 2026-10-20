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

// Local integration tier: real TLS control requests, signed authority/SDP and
// Pion transports; the existing test subscription adapter supplies ordered WSS
// events. This does not claim a real coordinator WSS or physical pause run.
type inboundRetirementTest struct {
	manager      *Manager
	active       *candidateSubscription
	old, next    protocol.CandidateTicket
	terminal     protocol.CandidateState
	source       *peer.Transport
	offer        protocol.Signal
	stateEntered chan struct{}
	stateRelease chan struct{}
	endEntered   chan struct{}
	endRelease   chan struct{}
	nextTURN     chan struct{}
	turnRelease  chan struct{}
	stateOnce    sync.Once
	endOnce      sync.Once
	stateUnblock sync.Once
	endUnblock   sync.Once
	turnUnblock  sync.Once
	turnOnce     sync.Once
	turnCalls    atomic.Int32
	stateReturns atomic.Int32
}

func newInboundRetirementTest(t *testing.T, status string) *inboundRetirementTest {
	t.Helper()
	f := &inboundRetirementTest{
		stateEntered: make(chan struct{}), stateRelease: make(chan struct{}),
		endEntered: make(chan struct{}), endRelease: make(chan struct{}),
		nextTURN: make(chan struct{}), turnRelease: make(chan struct{}),
	}
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
	stun, err := turn.NewServer(turn.ServerConfig{
		Realm:       "dshker.retirement.test",
		AuthHandler: func(*turn.RequestAttributes) (string, []byte, bool) { return "", nil, false },
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: socket, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
			RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
		}}},
	})
	if err != nil {
		socket.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { stun.Close() })
	manager.config.Endpoints.STUNAddress = socket.LocalAddr().String()
	request := protocol.PrepareCandidate{
		Registration: fence, AttemptID: protocol.NewNonce(), UserID: pin.Initiator.UserID,
		NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID,
		Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID,
	}
	remoteCore := protocol.NewNonce()
	f.old = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	request.AttemptID, request.Generation = protocol.NewNonce(), 2
	f.next = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	f.terminal = pendingCandidateState(f.old)
	f.terminal.Decision.Status, f.terminal.Decision.DecidedAt = status, time.Now().Unix()
	f.terminal.Decision.Reason = "p2p.candidate_cancelled"
	if status == "expired" {
		f.terminal.Decision.Reason = "p2p.lease_expired"
	}
	if err := manager.validateCandidateReceipt(f.old, f.terminal); err != nil {
		t.Fatal("terminal receipt must pass the real exact-ticket validator", err)
	}
	lease := f.next.Lease
	f.source, err = peer.NewTransport(manager.ctx, peer.TransportOptions{
		UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: socket.LocalAddr().String(),
		LocalDeviceID: lease.FromDeviceID, PeerDeviceID: lease.ToDeviceID,
		PrivateKey: remoteKey, PeerKey: localPublic, ServiceKey: manager.config.Authority.PublicKey,
		Scope: protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation,
			FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID},
		Revision: lease.Revision, Lease: lease, Ticket: &f.next,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.releaseState()
		f.releaseEnd()
		f.releaseTURN()
		manager.Close()
		f.source.Close()
	})
	f.offer, err = f.source.Offer(manager.ctx)
	if err != nil {
		t.Fatal("real signed successor offer could not be gathered", err)
	}
	return f
}

func (f *inboundRetirementTest) releaseState() { f.stateUnblock.Do(func() { close(f.stateRelease) }) }
func (f *inboundRetirementTest) releaseEnd()   { f.endUnblock.Do(func() { close(f.endRelease) }) }
func (f *inboundRetirementTest) releaseTURN()  { f.turnUnblock.Do(func() { close(f.turnRelease) }) }

func (f *inboundRetirementTest) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1/turn-credentials":
		if f.turnCalls.Add(1) > 1 {
			f.turnOnce.Do(func() { close(f.nextTURN) })
			select {
			case <-r.Context().Done():
				return
			case <-f.turnRelease:
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
		f.stateOnce.Do(func() { close(f.stateEntered) })
		select {
		case <-r.Context().Done():
			return
		case <-f.stateRelease:
		}
		f.stateReturns.Add(1)
		json.NewEncoder(w).Encode(f.terminal)
	case "/v2/candidates/cancel":
		var request protocol.CandidateAction
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Ticket != f.old || request.Registration != f.active.fence {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(f.terminal)
	case "/v2/end":
		var request protocol.EndCandidate
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Ticket != f.old || request.Reason != "failed" || request.Registration != f.active.fence {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.endOnce.Do(func() { close(f.endEntered) })
		select {
		case <-r.Context().Done():
			return
		case <-f.endRelease:
		}
		json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: f.old.Lease.AttemptID, Generation: f.old.Lease.Generation, Ended: true, Reason: request.Reason})
	default:
		http.NotFound(w, r)
	}
}

func inboundRetirementAwait(t *testing.T, ready <-chan struct{}, label string) bool {
	t.Helper()
	timer := time.NewTimer(1500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ready:
		return true
	case <-timer.C:
		t.Errorf("missing deterministic retirement boundary: %s", label)
		return false
	}
}

func (f *inboundRetirementTest) receiveOld(t *testing.T) *session {
	t.Helper()
	if !f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.old}) {
		t.Fatal("prepared event did not use the actual control receiver")
	}
	pair := f.nextPair()
	f.manager.mu.Lock()
	old := f.manager.inboundCandidates[pair]
	f.manager.mu.Unlock()
	if old == nil || old.ticket == nil || *old.ticket != f.old {
		t.Fatal("historical prepared event did not reserve its exact ticket")
	}
	if !inboundRetirementAwait(t, f.stateEntered, "old observer's first real TLS State request") {
		t.FailNow()
	}
	return old
}

func (f *inboundRetirementTest) nextPair() string {
	f.manager.mu.Lock()
	defer f.manager.mu.Unlock()
	pair, _ := f.manager.pairForRemoteLocked(f.next.Lease.FromDeviceID, f.next.Lease.NetworkID)
	return pair
}

func (f *inboundRetirementTest) receiveSuccessor(t *testing.T) {
	t.Helper()
	for _, event := range []controlplane.SignalEvent{
		{Type: "candidate", Ticket: f.next},
		{Type: "signal", Ticket: f.next, Signal: f.offer},
	} {
		if !f.manager.receiveControl(f.active, event) {
			t.Fatal("successor bypassed the actual ordered control receiver")
		}
	}
}

func (f *inboundRetirementTest) retainedSuccessor(t *testing.T, old *session) *session {
	t.Helper()
	if !inboundRetirementAwait(t, f.nextTURN, "one retained successor starts after terminal authority") {
		return nil
	}
	f.manager.mu.Lock()
	next := f.manager.inboundCandidates[old.PairID]
	_, retained := f.manager.retiring[old]
	valid := next != nil && next != old && next.ticket != nil && *next.ticket == f.next && len(next.signalInbox) == 1
	f.manager.mu.Unlock()
	if !valid || !retained {
		t.Errorf("terminal owner swallowed successor Prepared/offer or lost join responsibility: successor=%t retiring=%t", valid, retained)
		return nil
	}
	select {
	case <-old.done:
		t.Error("old owner falsely joined while its exact End reply was blocked")
	default:
	}
	return next
}

func (f *inboundRetirementTest) finishOld(t *testing.T, old, next *session, closeFirst bool) {
	t.Helper()
	if closeFirst {
		f.manager.Close()
	} else {
		f.releaseEnd()
	}
	if !inboundRetirementAwait(t, old.done, "old transport/signal/observer/End owner joined") {
		return
	}
	if next == nil {
		return
	}
	f.manager.mu.Lock()
	_, retired := f.manager.retiring[old]
	preserved := f.manager.inboundCandidates[old.PairID] == next
	f.manager.mu.Unlock()
	if retired || !closeFirst && !preserved {
		t.Error("old finish removed the new exact owner or retained finished ownership")
	}
	if closeFirst {
		if !inboundRetirementAwait(t, next.done, "Close also joined the successor TURN startup") {
			return
		}
		return
	}
	f.releaseTURN()
	select {
	case answer := <-f.active.sent:
		if answer.Type != "answer" || answer.AttemptID != f.next.Lease.AttemptID || answer.Generation != f.next.Lease.Generation {
			t.Error("retained offer did not produce its exact real transport answer")
		} else if err := f.source.AcceptAnswer(answer); err != nil {
			t.Error("real successor rejected its signed answer", err)
		}
	case <-f.manager.ctx.Done():
		t.Error("retained signed offer never reached AcceptOffer/SendCandidate")
	}
}

func TestInboundTerminalDecisionRetiresBeforeOrderedPreparedAndOffer(t *testing.T) {
	for _, status := range []string{"cancelled", "expired"} {
		for _, closeFirst := range []bool{false, true} {
			name := status + "/late-finish"
			if closeFirst {
				name = status + "/close-joins"
			}
			t.Run(name, func(t *testing.T) {
				f := newInboundRetirementTest(t, status)
				old := f.receiveOld(t)
				f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate-decision", State: f.terminal})
				if !inboundRetirementAwait(t, f.endEntered, "old exact End first reply blocked") {
					return
				}
				f.receiveSuccessor(t)
				next := f.retainedSuccessor(t, old)
				f.finishOld(t, old, next, closeFirst)
			})
		}
	}
}

func TestInboundHistoricalPreparedRetainsSuccessorUntilTerminalStateReadback(t *testing.T) {
	for _, status := range []string{"cancelled", "expired"} {
		t.Run(status, func(t *testing.T) {
			f := newInboundRetirementTest(t, status)
			previous := f.active
			current := candidateSubscriptionFor(f.manager.config.CoreInstanceID)
			current.fence.ServerEpoch = previous.fence.ServerEpoch
			f.manager.signals.mu.Lock()
			f.manager.signals.active = current
			f.manager.signals.mu.Unlock()
			f.active = current
			t.Cleanup(current.Close)
			previous.Close()
			old := f.receiveOld(t)
			// The old ticket is not yet known terminal locally. Do not release its
			// unknown slot or create parallel transport work merely to admit this.
			f.receiveSuccessor(t)
			if f.stateReturns.Load() != 0 || f.turnCalls.Load() != 1 {
				t.Fatal("successor bypassed the still-unanswered authoritative State boundary")
			}
			f.releaseState()
			if !inboundRetirementAwait(t, f.endEntered, "fresh exact terminal State led to old End") {
				return
			}
			next := f.retainedSuccessor(t, old)
			f.finishOld(t, old, next, false)
		})
	}
}
