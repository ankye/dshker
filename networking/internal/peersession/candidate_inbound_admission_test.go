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

// Local TLS/Pion integration, not a full coordinator-WSS or physical test. The
// existing subscription adapter feeds the real receiveControl admission path.
type inboundAdmissionBoundary struct {
	t                *testing.T
	manager          *Manager
	active           *candidateSubscription
	old, next, third protocol.CandidateTicket
	terminal         protocol.CandidateState
	oldOwner         *session
	source           *peer.Transport
	offer            protocol.Signal
	response         string
	firstRead        chan struct{}
	firstRelease     chan struct{}
	read             chan struct{}
	release          chan struct{}
	firstOnce        sync.Once
	readOnce         sync.Once
	firstReleaseOnce sync.Once
	releaseOnce      sync.Once
	stateCalls       atomic.Int32
	turnCalls        atomic.Int32
}

func newInboundAdmissionBoundary(t *testing.T, response string) *inboundAdmissionBoundary {
	t.Helper()
	f := &inboundAdmissionBoundary{t: t, response: response, firstRead: make(chan struct{}),
		firstRelease: make(chan struct{}), read: make(chan struct{}), release: make(chan struct{})}
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
		Realm:       "dshker.admission-boundary.test",
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
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(),
		UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID,
		Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	remoteCore := protocol.NewNonce()
	f.old = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	request.AttemptID, request.Generation = protocol.NewNonce(), 2
	f.next = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	request.AttemptID, request.Generation = protocol.NewNonce(), 3
	f.third = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	f.terminal = inboundAdmissionTerminal(f.old)
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
		f.unblock()
		f.firstReleaseOnce.Do(func() { close(f.firstRelease) })
		manager.Close()
		f.source.Close()
	})
	f.offer, err = f.source.Offer(manager.ctx)
	if err != nil {
		t.Fatal("real signed SDP setup failed", err)
	}
	manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.old})
	manager.mu.Lock()
	f.oldOwner = manager.inboundCandidates[pin.Pair.PairID]
	manager.mu.Unlock()
	if f.oldOwner == nil || f.oldOwner.ticket == nil || *f.oldOwner.ticket != f.old {
		t.Fatal("old owner did not enter the actual inbound reservation")
	}
	if !inboundRetirementAwait(t, f.firstRead, "old observer's first TLS State request") {
		t.FailNow()
	}
	return f
}

func inboundAdmissionTerminal(ticket protocol.CandidateTicket) protocol.CandidateState {
	state := pendingCandidateState(ticket)
	state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
	return state
}

func (f *inboundAdmissionBoundary) unblock() { f.releaseOnce.Do(func() { close(f.release) }) }

func (f *inboundAdmissionBoundary) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1/turn-credentials":
		f.turnCalls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.relay_unconfigured"})
	case "/v2/candidates/state":
		f.serveState(w, r)
	case "/v2/candidates/cancel":
		var action protocol.CandidateAction
		if json.NewDecoder(r.Body).Decode(&action) != nil || !f.ownsTicket(action.Ticket) {
			f.t.Error("cleanup Cancel changed its exact admitted ticket")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(inboundAdmissionTerminal(action.Ticket))
	case "/v2/end":
		var end protocol.EndCandidate
		if json.NewDecoder(r.Body).Decode(&end) != nil || !f.ownsTicket(end.Ticket) {
			f.t.Error("cleanup End changed its exact admitted ticket")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: end.Ticket.Lease.AttemptID, Generation: end.Ticket.Lease.Generation, Ended: true, Reason: end.Reason})
	default:
		f.t.Error("admission dispatched an unrelated HTTP operation", r.URL.Path)
		http.NotFound(w, r)
	}
}

func (f *inboundAdmissionBoundary) ownsTicket(ticket protocol.CandidateTicket) bool {
	return ticket == f.old || ticket == f.next || ticket == f.third
}

func (f *inboundAdmissionBoundary) serveState(w http.ResponseWriter, r *http.Request) {
	var request protocol.CandidateStateRequest
	if json.NewDecoder(r.Body).Decode(&request) != nil {
		f.t.Error("State request was not typed JSON")
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if request.AttemptID != f.old.Lease.AttemptID {
		for _, ticket := range []protocol.CandidateTicket{f.next, f.third} {
			if request.AttemptID == ticket.Lease.AttemptID {
				json.NewEncoder(w).Encode(inboundAdmissionTerminal(ticket))
				return
			}
		}
		f.t.Error("State substituted an unknown attempt")
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	lease := f.old.Lease
	if request.UserID != lease.UserID || request.NetworkID != lease.NetworkID || request.PairID != lease.PairID || request.Registration != f.active.fence {
		f.t.Error("admission State lost the captured old ticket/fence")
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if f.stateCalls.Add(1) == 1 {
		f.firstOnce.Do(func() { close(f.firstRead) })
		select {
		case <-r.Context().Done():
			return
		case <-f.firstRelease:
			json.NewEncoder(w).Encode(pendingCandidateState(f.old))
			return
		}
	}
	f.readOnce.Do(func() { close(f.read) })
	// Deliberately hold the server body even if its request is cancelled. Scope
	// retirement must join the local owner without trusting this late completion.
	<-f.release
	state := f.terminal
	switch f.response {
	case "pending":
		state = pendingCandidateState(f.old)
	case "429":
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
		return
	case "wrong-ticket":
		state.Ticket = f.next
	case "bad-signature":
		state.LatestLease.Signature = "invalid"
	}
	json.NewEncoder(w).Encode(state)
}

func (f *inboundAdmissionBoundary) queue(t *testing.T) *inboundAdmission {
	t.Helper()
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.next})
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "signal", Ticket: f.next, Signal: f.offer})
	f.manager.mu.Lock()
	job := f.manager.inboundAdmissions[f.oldOwner.PairID]
	valid := job != nil && job.previous == f.oldOwner && job.connection.ticket != nil && *job.connection.ticket == f.next && cap(job.connection.signalInbox) == 1 && len(job.connection.signalInbox) == 1
	f.manager.mu.Unlock()
	if !valid {
		t.Fatal("unresolved predecessor did not retain one exact bounded admission owner")
	}
	if !inboundRetirementAwait(t, f.read, "admission's independent exact-old TLS State read") {
		t.FailNow()
	}
	return job
}

func (f *inboundAdmissionBoundary) assertOldUnchanged(t *testing.T, job *inboundAdmission) {
	t.Helper()
	f.manager.mu.Lock()
	_, retired := f.manager.retiring[f.oldOwner]
	current := f.manager.inboundCandidates[f.oldOwner.PairID] == f.oldOwner
	transport := job.connection.transport
	f.manager.mu.Unlock()
	if !current || retired || f.oldOwner.ctx.Err() != nil || transport != nil || f.turnCalls.Load() != 1 {
		t.Error("unproven State retired old authority or started the queued transport")
	}
}

func (f *inboundAdmissionBoundary) assertRefusedOwnerJoined(t *testing.T, job *inboundAdmission) {
	t.Helper()
	if !inboundRetirementAwait(t, job.connection.done, "refused queued candidate cleanup joined") {
		return
	}
	f.manager.mu.Lock()
	retained := f.manager.inboundAdmissions[f.oldOwner.PairID] == job
	f.manager.mu.Unlock()
	if retained {
		t.Error("refused admission kept its directed-pair owner after join")
	}
}

func TestInboundAdmissionRejectsUnprovenRetirement(t *testing.T) {
	for _, kind := range []string{"pending", "429", "wrong-ticket", "bad-signature"} {
		t.Run(kind, func(t *testing.T) {
			f := newInboundAdmissionBoundary(t, kind)
			job := f.queue(t)
			f.assertOldUnchanged(t, job)
			f.unblock()
			if !inboundRetirementAwait(t, job.done, "explicit refusal completed the admission read owner") {
				return
			}
			code, typed := protocol.Refusal(job.err)
			if job.err == nil || !typed || code == "" {
				t.Error("unknown/pending retirement was not an explicit typed failure", job.err)
			}
			if kind == "429" && code != "p2p.rate_limited" || kind == "wrong-ticket" && code != "p2p.candidate_scope_mismatch" || kind == "bad-signature" && code != "p2p.identity_mismatch" {
				t.Error("retirement refusal lost its actual cause", code)
			}
			f.assertOldUnchanged(t, job)
			f.assertRefusedOwnerJoined(t, job)
		})
	}
}

func TestInboundAdmissionScopeChangesCancelLatePublicationAndJoin(t *testing.T) {
	for _, change := range []string{"account", "pin-removal", "pin-revision", "network", "subscription", "close"} {
		t.Run(change, func(t *testing.T) {
			f := newInboundAdmissionBoundary(t, "terminal")
			job := f.queue(t)
			changed := make(chan struct{})
			var changeErr error
			go func() { changeErr = f.changeScope(change); close(changed) }()
			t.Cleanup(func() {
				f.unblock()
				inboundRetirementAwait(t, changed, "scope mutation goroutine joined")
			})
			if !inboundRetirementAwait(t, job.done, "scope loss cancelled and joined the in-flight read") {
				f.unblock()
				return
			}
			if job.err == nil {
				t.Error("changed authority accepted the admission")
			}
			f.unblock()
			if !inboundRetirementAwait(t, changed, "scope mutation completed its own join") {
				return
			}
			if changeErr != nil {
				t.Error("scope mutation itself failed", changeErr)
			}
			f.manager.mu.Lock()
			published := f.manager.inboundCandidates[f.oldOwner.PairID] == job.connection || f.manager.inbound[f.oldOwner.PairID] == job.connection
			transport := job.connection.transport
			f.manager.mu.Unlock()
			if published || transport != nil || f.turnCalls.Load() != 1 {
				t.Error("late terminal body published under changed scope")
			}
			if change == "close" && !inboundRetirementAwait(t, job.connection.done, "Close joined queued connection cleanup") {
				return
			}
		})
	}
}

func (f *inboundAdmissionBoundary) changeScope(change string) error {
	switch change {
	case "account":
		completion, err := f.manager.FenceAccountForLogout()
		if completion != nil {
			completion.Wait()
		}
		return err
	case "pin-removal":
		return f.manager.RetireScopedPin(f.oldOwner.PairID, f.old.Lease.NetworkID)
	case "pin-revision":
		f.manager.mu.Lock()
		pin := f.manager.pins[f.oldOwner.PairID]
		f.manager.mu.Unlock()
		pin.Pair.Revision++
		return f.manager.Pin(pin)
	case "network":
		return f.manager.RevokeNetwork(f.old.Lease.NetworkID)
	case "subscription":
		next := candidateSubscriptionFor(f.manager.config.CoreInstanceID)
		next.fence.ServerEpoch = f.active.fence.ServerEpoch
		f.manager.signals.mu.Lock()
		f.manager.signals.active = next
		f.manager.signals.mu.Unlock()
		f.active.Close()
		return nil
	case "close":
		f.manager.Close()
		return nil
	}
	panic("unregistered admission scope change")
}

func TestInboundAdmissionDuplicateAndConflictKeepExactOwner(t *testing.T) {
	f := newInboundAdmissionBoundary(t, "terminal")
	job := f.queue(t)
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.next})
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.third})
	f.manager.mu.Lock()
	retained := f.manager.inboundAdmissions[f.oldOwner.PairID] == job && *job.connection.ticket == f.next && len(job.connection.signalInbox) == 1
	f.manager.mu.Unlock()
	if !retained || f.stateCalls.Load() != 2 {
		t.Fatal("duplicate created work or conflicting ticket overwrote the queued exact owner")
	}
	f.unblock()
	if !inboundRetirementAwait(t, job.done, "terminal proof published the original queued owner once") {
		return
	}
	f.manager.mu.Lock()
	published := f.manager.inboundCandidates[f.oldOwner.PairID] == job.connection
	f.manager.mu.Unlock()
	if job.err != nil || !published {
		t.Fatal("valid terminal proof did not publish the original ticket", job.err)
	}
	select {
	case answer := <-f.active.sent:
		if answer.AttemptID != f.next.Lease.AttemptID || answer.Generation != f.next.Lease.Generation || answer.Type != "answer" {
			t.Error("duplicate/conflict changed the exact answered offer")
		} else if err := f.source.AcceptAnswer(answer); err != nil {
			t.Error("real source rejected the retained signed answer", err)
		}
	case <-f.manager.ctx.Done():
		t.Error("retained real offer did not reach the actual transport answer")
	}
}

func TestInboundAdmissionSignalOverflowStopsOnlyQueuedOwner(t *testing.T) {
	f := newInboundAdmissionBoundary(t, "terminal")
	job := f.queue(t)
	f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "signal", Ticket: f.next, Signal: f.offer})
	if !inboundRetirementAwait(t, job.done, "bounded overflow joined only its own admission read") {
		return
	}
	job.connection.diagnostic.mu.Lock()
	termination := job.connection.diagnostic.termination
	valid := termination != nil && termination.Code == "p2p.signal_limit"
	job.connection.diagnostic.mu.Unlock()
	if !valid || job.connection.ctx.Err() == nil || f.oldOwner.ctx.Err() != nil || f.manager.ctx.Err() != nil {
		t.Error("overflow was hidden or cancelled another owner")
	}
	f.assertOldUnchanged(t, job)
	f.assertRefusedOwnerJoined(t, job)
}

func TestInboundAdmissionCurrentCommittedUsesPromotionBarrier(t *testing.T) {
	for _, dead := range []bool{false, true} {
		name := "live"
		if dead {
			name = "dead"
		}
		t.Run(name, func(t *testing.T) {
			manager, old, ticket, next, active, _ := readyInboundOrderFixture(t, true)
			if dead {
				if err := old.mux.Close(); err != nil {
					t.Fatal(err)
				}
			}
			manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate", Ticket: next})
			manager.mu.Lock()
			job := manager.inboundAdmissions[old.PairID]
			manager.mu.Unlock()
			if job == nil {
				t.Fatal("current committed reservation did not get an exact admission read owner")
			}
			if !inboundRetirementAwait(t, job.done, "current committed State used the existing exact promotion barrier") {
				return
			}
			manager.mu.Lock()
			published := manager.inboundCandidates[old.PairID] == job.connection && *job.connection.ticket == next
			_, retired := manager.retiring[old]
			promoted := old.promoted && manager.inbound[old.PairID] == old
			managerTicket := old.ticket
			manager.mu.Unlock()
			if job.err != nil || !published || !dead && (!promoted || retired || old.ctx.Err() != nil) || dead && (!retired || old.ctx.Err() == nil || old.promoted) {
				t.Error("current committed authority was misclassified as cancellation", job.err)
			}
			old.diagnostic.mu.Lock()
			termination := old.diagnostic.termination
			cancelled := termination != nil && termination.Code == "p2p.candidate_cancelled"
			old.diagnostic.mu.Unlock()
			if cancelled || managerTicket == nil || *managerTicket != ticket {
				t.Error("promotion/dead-carrier handling changed the old immutable authority")
			}
		})
	}
}
