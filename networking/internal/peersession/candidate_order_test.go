package peersession

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/pion/turn/v5"
)

type orderedReadyReply struct {
	entered      chan struct{}
	release      chan struct{}
	once         sync.Once
	finish       sync.Once
	turnRelease  chan struct{}
	turnOnce     sync.Once
	endRequests  chan protocol.EndCandidate
	remoteKey    ed25519.PrivateKey
	authorityKey ed25519.PrivateKey
	predecessor  *session
}

func (reply *orderedReadyReply) unblock()    { reply.finish.Do(func() { close(reply.release) }) }
func (reply *orderedReadyReply) permitTURN() { reply.turnOnce.Do(func() { close(reply.turnRelease) }) }

func readyInboundOrderFixture(t *testing.T, withPredecessor bool) (*Manager, *session, protocol.CandidateTicket, protocol.CandidateTicket, subscription, *orderedReadyReply) {
	t.Helper()
	var oldTicket protocol.CandidateTicket
	var requests int
	ready := &orderedReadyReply{entered: make(chan struct{}), release: make(chan struct{}), turnRelease: make(chan struct{}), endRequests: make(chan protocol.EndCandidate, 4)}
	manager, fence, authorityKey := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/turn-credentials":
			requests++
			if requests > 1 {
				select {
				case <-r.Context().Done():
				case <-ready.turnRelease:
				}
			}
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.relay_unconfigured"})
		case "/v2/candidates/ready":
			state := pendingCandidateState(oldTicket)
			state.ToReady = true // The delayed pre-commit HTTP snapshot.
			ready.once.Do(func() { close(ready.entered) })
			select {
			case <-r.Context().Done():
			case <-ready.release:
			}
			json.NewEncoder(w).Encode(state)
		case "/v2/end":
			var request protocol.EndCandidate
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			ready.endRequests <- request
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: oldTicket.Lease.AttemptID, Generation: oldTicket.Lease.Generation, Reason: request.Reason, CurrentActiveAttemptID: oldTicket.Lease.AttemptID, CurrentActiveGeneration: oldTicket.Lease.Generation})
		case "/v2/candidates/state":
			state := pendingCandidateState(oldTicket)
			state.FromReady, state.ToReady = true, true
			state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
			state.CurrentActiveAttemptID, state.CurrentActiveGeneration = oldTicket.Lease.AttemptID, oldTicket.Lease.Generation
			json.NewEncoder(w).Encode(state)
		default:
			t.Error("ordered candidate fixture dispatched unrelated control", r.URL.Path)
		}
	}))
	ready.authorityKey = authorityKey
	_, pin := pinFixture()
	localPublic, localPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	remotePublic, remotePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ready.remoteKey = remotePrivate
	manager.config.PrivateKey, manager.config.Device.PublicKey = localPrivate, localPublic
	manager.emit = func(State) { t.Error("target commit admission invoked a Host state callback") }
	pin.Initiator.PublicKey, pin.Target.PublicKey = localPublic, remotePublic
	manager.pins[pin.Pair.PairID] = pin
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stun, err := turn.NewServer(turn.ServerConfig{Realm: "dshker.order.test", AuthHandler: func(*turn.RequestAttributes) (string, []byte, bool) { return "", nil, false }, PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: socket, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1"}}}})
	if err != nil {
		socket.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { stun.Close() })
	manager.config.Endpoints.STUNAddress = socket.LocalAddr().String()
	request := protocol.PrepareCandidate{AttemptID: protocol.NewNonce(), Registration: fence, UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID, Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	remoteCore := protocol.NewNonce()
	if withPredecessor {
		predecessorTicket := signedCandidate(request, pin.Target.DeviceID, remoteCore, authorityKey)
		previous := newSession(manager.ctx)
		previous.PairID, previous.ticket, previous.lease, previous.promoted = pin.Pair.PairID, &predecessorTicket, predecessorTicket.Lease, true
		link := entryLink{messages: make(chan []byte), done: make(chan struct{})}
		mux, err := peer.NewMux(link, peer.StreamScope{AttemptID: request.AttemptID, Generation: request.Generation, RuntimeGeneration: 7})
		if err != nil {
			t.Fatal(err)
		}
		_, endpoint, err := runtimebridge.Attach(manager.ctx, mux, runtimebridge.Binding{Generation: 7, URL: "http://127.0.0.1:1/?token=ordered-predecessor-test"}, false, nil)
		if err != nil {
			t.Fatal(err)
		}
		previous.mux, previous.endpoint = mux, endpoint
		previous.result.State = State{PairID: previous.PairID, AttemptID: request.AttemptID, Generation: request.Generation, RuntimeGeneration: 7, Stage: "ready"}
		manager.inbound[previous.PairID] = previous
		manager.inboundEndpoints = map[string]*runtimebridge.Endpoint{previous.PairID: endpoint}
		ready.predecessor = previous
		t.Cleanup(func() { endpoint.Close(); mux.Close(); manager.finish(previous.PairID, previous) })
		request.PreviousAttemptID, request.PreviousGeneration = request.AttemptID, request.Generation
		request.AttemptID, request.Generation = protocol.NewNonce(), request.Generation+1
	}
	oldTicket = signedCandidate(request, pin.Target.DeviceID, remoteCore, authorityKey)
	connection, err := manager.reserveInboundCandidate(oldTicket)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.createCandidateTransport(connection); err != nil {
		t.Fatal(err)
	}
	lease := oldTicket.Lease
	source, err := peer.NewTransport(manager.ctx, peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: socket.LocalAddr().String(), LocalDeviceID: lease.FromDeviceID, PeerDeviceID: lease.ToDeviceID, PrivateKey: remotePrivate, PeerKey: localPublic, ServiceKey: manager.config.Authority.PublicKey, Scope: protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}, Revision: lease.Revision, Lease: lease, Ticket: &oldTicket})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		manager.mu.Lock()
		manager.closed = true
		manager.mu.Unlock()
		manager.cancel()
		ready.permitTURN()
		ready.unblock()
		closeCandidateTransport(t, connection)
		source.Close()
		if connection.mux != nil {
			connection.mux.Close()
		}
		manager.finish(connection.PairID, connection)
		if ready.predecessor != nil {
			ready.predecessor.mux.Close()
			manager.finish(ready.predecessor.PairID, ready.predecessor)
		}
		manager.Close()
	})
	ctx, cancel := context.WithTimeout(manager.ctx, 3*time.Second)
	defer cancel()
	offer, err := source.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := connection.transport.AcceptOffer(ctx, offer)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, transport := range []*peer.Transport{source, connection.transport} {
		if err := transport.WaitReady(ctx); err != nil {
			t.Fatal(err)
		}
	}
	mux, err := peer.NewMux(connection.transport, peer.StreamScope{AttemptID: lease.AttemptID, Generation: lease.Generation, RuntimeGeneration: 0, Initiator: false})
	if err != nil {
		t.Fatal(err)
	}
	connection.mux = mux
	connection.result.State = State{PairID: connection.PairID, AttemptID: lease.AttemptID, Generation: lease.Generation, Stage: "starting-runtime"}
	request.AttemptID, request.Generation = protocol.NewNonce(), request.Generation+1
	request.PreviousAttemptID, request.PreviousGeneration = lease.AttemptID, lease.Generation
	next := signedCandidate(request, pin.Target.DeviceID, remoteCore, authorityKey)
	active, _ := manager.signals.current()
	return manager, connection, oldTicket, next, active, ready
}

func TestDeadCommittedTargetReleasesOneCandidateSlotWithoutEndingSuccessor(t *testing.T) {
	testDeadCommittedTargetSuccessor(t, false)
}

func TestExpiredCommittedDeadTargetReleasesOneCandidateSlotWithoutEndingSuccessor(t *testing.T) {
	testDeadCommittedTargetSuccessor(t, true)
}

func testDeadCommittedTargetSuccessor(t *testing.T, expired bool) {
	t.Helper()
	manager, old, ticket, next, active, control := readyInboundOrderFixture(t, true)
	previous := control.predecessor
	oldURL := previous.endpoint.LocalURL()
	if err := old.mux.Close(); err != nil {
		t.Fatal(err)
	}
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	if expired {
		state.LatestLease.ExpiresAt = time.Now().Add(-time.Second).Unix()
		state.LatestLease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(control.authorityKey, state.LatestLease.SigningBytes()))
		state.Decision.Lease = state.LatestLease
		if err := manager.validateCandidateReceipt(ticket, state); err != nil {
			t.Fatal("expired historical receipt lost its signature or exact scope", err)
		}
	}
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	manager.mu.Lock()
	_, retiring := manager.retiring[old]
	valid := retiring && !old.promoted && manager.inbound[old.PairID] == nil && manager.inboundCandidates[old.PairID] == nil && !old.scopeRetired
	manager.mu.Unlock()
	if !valid || connectionState(old).Stage == "ready" || old.ctx.Err() == nil {
		t.Fatal("dead committed target claimed ready or retained candidate admission")
	}
	if !previous.remoteReplaced || connectionState(previous).Stage == "ready" || previous.ctx.Err() == nil || previous.endpoint.CurrentMux() != nil || previous.endpoint.LocalURL() != oldURL {
		t.Fatal("committed successor revived predecessor authority or changed its stable gateway")
	}
	select {
	case <-previous.mux.Done():
	default:
		t.Fatal("superseded predecessor still forwards through its old mux")
	}
	if _, err := previous.endpoint.Binding(); err != nil {
		t.Fatal("carrier retirement closed the reusable stable gateway", err)
	}
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate", Ticket: next})
	manager.mu.Lock()
	successor := manager.inboundCandidates[old.PairID]
	manager.mu.Unlock()
	if successor == nil || successor.ticket == nil || *successor.ticket != next {
		t.Fatal("ordered successor could not enter the unique candidate slot")
	}
	// Prepared ordering is established. Do not charge this fixture's artificial
	// TURN gate or complete SDP gathering against the DTLS readiness guard.
	control.permitTURN()
	lease := next.Lease
	source, err := peer.NewTransport(manager.ctx, peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: manager.config.Endpoints.STUNAddress, LocalDeviceID: lease.FromDeviceID, PeerDeviceID: lease.ToDeviceID, PrivateKey: control.remoteKey, PeerKey: manager.config.Device.PublicKey, ServiceKey: manager.config.Authority.PublicKey, Scope: protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}, Revision: lease.Revision, Lease: lease, Ticket: &next})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	setupCtx, stopSetup := context.WithTimeout(manager.ctx, 3*time.Second)
	defer stopSetup()
	started := time.Now()
	offer, err := source.Offer(setupCtx)
	if err != nil {
		t.Fatal(err)
	}
	offerReady := time.Now()
	manager.receiveControl(active, controlplane.SignalEvent{Type: "signal", Ticket: next, Signal: offer})
	select {
	case answer := <-active.(*candidateSubscription).sent:
		if answer.AttemptID != next.Lease.AttemptID || answer.Type != "answer" || source.AcceptAnswer(answer) != nil {
			t.Fatal("successor did not answer with its exact admitted ticket")
		}
	case <-setupCtx.Done():
		t.Fatal("successor offer was discarded behind the dead committed target")
	}
	answerReady := time.Now()
	stopSetup()
	readyCtx, stopReady := context.WithTimeout(manager.ctx, 3*time.Second)
	defer stopReady()
	deadline, _ := manager.ctx.Deadline()
	remaining := time.Until(deadline)
	if err := source.WaitReady(readyCtx); err != nil {
		t.Fatalf("successor's real transport answer could not establish: %v; offer=%s answer=%s ready=%s parentRemaining=%s parentError=%v source=%+v target=%+v", err, offerReady.Sub(started), answerReady.Sub(offerReady), time.Since(answerReady), remaining, manager.ctx.Err(), source.Diagnostics(), successor.transport.Diagnostics())
	}
	t.Logf("successor transport phases: offer=%s answer=%s ready=%s parentRemaining=%s", offerReady.Sub(started), answerReady.Sub(offerReady), time.Since(answerReady), remaining)
	manager.endCandidate(old, "failed")
	select {
	case request := <-control.endRequests:
		if request.Ticket != ticket || request.Reason != "failed" {
			t.Fatal("dead carrier cleanup could cancel the successor's predecessor CAS", request.Reason)
		}
	default:
		t.Fatal("dead carrier cleanup lost its exact immutable ticket")
	}
	closed := make(chan struct{})
	go func() { manager.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close forgot the moved retiring target")
	case <-time.After(20 * time.Millisecond):
	}
	manager.cleanupCandidate(old, connectionState(old))
	manager.cleanupCandidate(previous, connectionState(previous))
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close did not join both the retiring target and successor worker")
	}
}

func TestExpiredCommittedLiveTargetCannotPromote(t *testing.T) {
	manager, old, ticket, _, active, control := readyInboundOrderFixture(t, false)
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	state.LatestLease.ExpiresAt = time.Now().Add(-time.Second).Unix()
	state.LatestLease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(control.authorityKey, state.LatestLease.SigningBytes()))
	state.Decision.Lease = state.LatestLease
	if err := manager.validateCandidateReceipt(ticket, state); err != nil {
		t.Fatal("expired historical receipt lost its signature or exact scope", err)
	}
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	manager.mu.Lock()
	retained := !old.promoted && manager.inbound[old.PairID] == nil && manager.inboundCandidates[old.PairID] == old && len(manager.retiring) == 0
	manager.mu.Unlock()
	if !retained || old.ctx.Err() != nil || !old.transport.LiveState().Ready || old.transport.Diagnostics().LeaseExpiresAt != ticket.Lease.ExpiresAt {
		t.Fatal("expired receipt granted live promotion, changed the current lease or retired a live candidate")
	}
}

func TestTargetCommittedEventPromotesBeforeImmediatelyFollowingSuccessorPrepare(t *testing.T) {
	manager, old, ticket, next, active, ready := readyInboundOrderFixture(t, false)
	readyResult := make(chan error, 1)
	go func() { readyResult <- manager.readyCandidate(old) }()
	select {
	case <-ready.entered:
	case <-manager.ctx.Done():
		t.Fatal("target Ready request did not enter the controlled in-flight window")
	}
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	manager.mu.Lock()
	promoted := old.promoted && manager.inbound[old.PairID] == old && manager.inboundCandidates[old.PairID] == nil
	manager.mu.Unlock()
	if !promoted {
		t.Fatal("ordered committed event left the old target in its candidate slot")
	}
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate", Ticket: next})
	manager.receiveControl(active, controlplane.SignalEvent{Type: "signal", Ticket: next, Signal: protocol.Signal{AttemptID: next.Lease.AttemptID, Type: "offer"}})
	manager.mu.Lock()
	successor := manager.inboundCandidates[old.PairID]
	valid := successor != nil && successor.ticket != nil && *successor.ticket == next && manager.inbound[old.PairID] == old && len(successor.signalInbox) == 1
	manager.mu.Unlock()
	if !valid {
		t.Fatal("immediately following prepared/offer was discarded behind committed predecessor")
	}
	ready.unblock()
	if err := <-readyResult; err != nil || !manager.isPromoted(old) {
		t.Fatal("late pending Ready reply undid target promotion", err)
	}
	if err := manager.promoteCandidate(old, state, false); err != nil {
		t.Fatal("late ordinary resolver could not observe an already promoted target", err)
	}
	manager.mu.Lock()
	intact := manager.inbound[old.PairID] == old && manager.inboundCandidates[old.PairID] == successor
	manager.mu.Unlock()
	if !intact {
		t.Fatal("late Ready/ordinary resolver removed the newly reserved successor")
	}
}

func TestSupersededSubscriptionCannotFastPromoteTarget(t *testing.T) {
	manager, old, ticket, _, prior, _ := readyInboundOrderFixture(t, false)
	admission := &targetPromotionAdmission{owner: manager.signals, active: prior, fence: prior.(*candidateSubscription).fence}
	next := candidateSubscriptionFor(manager.config.CoreInstanceID)
	manager.signals.mu.Lock()
	manager.signals.active = next
	manager.signals.mu.Unlock()
	t.Cleanup(next.Close)
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	manager.receiveControl(prior, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	if manager.isPromoted(old) {
		t.Fatal("superseded control receiver fast-promoted an old event")
	}
	if err := manager.promoteCandidateFrom(old, state, false, admission); err == nil || err.Error() != "p2p.registration_stale" || manager.isPromoted(old) {
		t.Fatal("slot barrier accepted a superseded subscription after its initial receiver check", err)
	}
}

func TestTargetCommittedEventRequiresFullReceiptAndBothReadyFlags(t *testing.T) {
	manager, old, ticket, _, active, _ := readyInboundOrderFixture(t, false)
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	for _, invalid := range []string{"source-not-ready", "target-not-ready", "invalid-signed-receipt"} {
		receipt := state
		switch invalid {
		case "source-not-ready":
			receipt.FromReady = false
		case "target-not-ready":
			receipt.ToReady = false
		case "invalid-signed-receipt":
			receipt.Decision.Lease.Signature = "invalid"
		}
		manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: receipt})
		if manager.isPromoted(old) {
			t.Fatal("incomplete or unauthenticated committed receipt promoted a target", invalid)
		}
	}
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	if !manager.isPromoted(old) {
		t.Fatal("valid committed receipt could not advance after rejected observations")
	}
}
