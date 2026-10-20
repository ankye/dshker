package peersession

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestRetiredPrimaryCannotPublishDeferredReadyOrOwnCurrentState(t *testing.T) {
	manager, primary, ticket := preparedCandidateFor(t, http.NotFoundHandler())
	_, identity := pinFixture()
	remote := identity.Target.DeviceID
	manager.mu.Lock()
	delete(manager.candidates, primary.PairID)
	delete(manager.pins, primary.PairID)
	primary.PairID, primary.promoted = remote, true
	identity.Pair.PairID = remote
	manager.pins[remote], manager.sessions[remote] = identity, primary
	ready := State{PairID: remote, AttemptID: ticket.Lease.AttemptID, Generation: ticket.Lease.Generation, RuntimeGeneration: 8, Stage: "ready"}
	primary.result.State = ready
	manager.mu.Unlock()
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var published atomic.Bool
	manager.emit = func(state State) {
		close(entered)
		<-release // Like Host.emit waiting for the selecting account's lock.
		if manager.OwnsState(state) {
			published.Store(true)
		}
	}
	go func() { manager.emitCurrent(ready); close(returned) }()
	<-entered
	if err := manager.RetireScopedPin(remote, identity.Pair.NetworkID); err != nil {
		t.Fatal(err)
	}
	if manager.OwnsState(ready) {
		t.Fatal("retired attempt retained current callback authority")
	}
	if _, err := manager.CurrentState(remote); err == nil || err.Error() != "p2p.connection_not_found" {
		t.Fatal("retiring primary was still returned as current", err)
	}
	identity.Pair.NetworkID = protocol.NewID()
	fence, err := manager.CurrentRegistration(identity.Initiator.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.CommitScopedPins(fence, identity.Initiator.UserID, []controlplane.PairIdentity{identity}, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	next, err := manager.reserveCandidate(remote, ticket.Lease.Generation+1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	<-returned
	if published.Load() {
		t.Fatal("old deferred ready projected into the fresh scope")
	}
	manager.finish(remote, primary)
	manager.mu.Lock()
	_, retired := manager.retiring[primary]
	preserved := manager.candidates[remote] == next
	manager.mu.Unlock()
	if retired || !preserved {
		t.Fatal("old finish forgot retiring ownership or removed the successor")
	}
	manager.finish(remote, next)
}

func TestManagerCloseJoinsRetiringSessionWithoutCurrentOwnership(t *testing.T) {
	manager, connection, _ := preparedCandidateFor(t, http.NotFoundHandler())
	if err := manager.RetireScopedPin(connection.PairID, connection.lease.NetworkID); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { manager.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close forgot the moved retiring owner")
	case <-time.After(20 * time.Millisecond):
	}
	manager.finish(connection.PairID, connection)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close did not join the finished retiring owner")
	}
}

func TestRetiringUnknownPrepareResolvesExactIDAndCannotCreateTransport(t *testing.T) {
	var manager *Manager
	var fence protocol.RegistrationFence
	var key ed25519.PrivateKey
	var ticket protocol.CandidateTicket
	entered, release := make(chan struct{}), make(chan struct{})
	var cancelled atomic.Int32
	manager, fence, key = controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: strings.Repeat("a", 32), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			var request protocol.PrepareCandidate
			json.NewDecoder(r.Body).Decode(&request)
			ticket = signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
			close(entered)
			<-release
			w.Write([]byte(`{"version":1}`))
		case "/v2/candidates/state":
			json.NewEncoder(w).Encode(pendingCandidateState(ticket))
		case "/v2/candidates/cancel":
			var action protocol.CandidateAction
			if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
				t.Error("retiring resolver changed its immutable ticket")
			}
			cancelled.Add(1)
			state := pendingCandidateState(ticket)
			state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
			json.NewEncoder(w).Encode(state)
		case "/v2/end":
			var request protocol.EndCandidate
			json.NewDecoder(r.Body).Decode(&request)
			if request.Ticket != ticket || request.Reason != "removed" {
				t.Error("explicit scope retirement did not end its exact authority", request.Reason)
			}
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: ticket.Lease.AttemptID, Generation: ticket.Lease.Generation, Ended: true, Reason: request.Reason})
		default:
			t.Error("retiring resolver created unrelated resource", r.URL.Path)
		}
	}))
	_, pin := pinFixture()
	result := make(chan error, 1)
	go func() { _, err := manager.Connect(context.Background(), pin.Pair.PairID, 1, false); result <- err }()
	<-entered
	manager.mu.Lock()
	connection := manager.candidates[pin.Pair.PairID]
	manager.mu.Unlock()
	if err := manager.RetireScopedPin(pin.Pair.PairID, pin.Pair.NetworkID); err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	_, retained := manager.retiring[connection]
	current := manager.candidates[pin.Pair.PairID]
	manager.mu.Unlock()
	if !retained || current != nil {
		t.Fatal("unknown exact ID was dropped or retained current ownership")
	}
	close(release)
	select {
	case err := <-result:
		if err == nil || err.Error() != "p2p.candidate_cancelled" {
			t.Fatal("retiring prepare did not resolve its authoritative cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("retiring unknown prepare could not install ticket for cleanup")
	}
	<-connection.done
	if cancelled.Load() != 1 || connection.transport != nil {
		t.Fatal("retiring prepare created transport or skipped cancellation")
	}
	manager.mu.Lock()
	_, retained = manager.retiring[connection]
	manager.mu.Unlock()
	if retained {
		t.Fatal("finished exact resolver retained a retiring slot")
	}
}
