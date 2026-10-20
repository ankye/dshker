package peersession

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/pion/turn/v5"
)

// Real TLS control, Ed25519 ticket and two actual Pion transports. No DSH,
// Keychain, production service or installed runtime is opened by this fixture.
func liveCandidateHandoffFixture(t *testing.T, handler http.Handler) (*Manager, *session, protocol.CandidateTicket) {
	t.Helper()
	manager, connection, ticket, _ := candidateHandoffTransportFixture(t, handler, true)
	return manager, connection, ticket
}

func candidateHandoffTransportFixture(t *testing.T, handler http.Handler, connect bool) (*Manager, *session, protocol.CandidateTicket, *peer.Transport) {
	t.Helper()
	manager, connection, ticket := preparedCandidateFor(t, handler)
	candidateTransportKey(t, manager, connection)
	remotePublic, remotePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pin := manager.pins[connection.PairID]
	pin.Target.PublicKey = remotePublic
	manager.pins[connection.PairID] = pin
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stun, err := turn.NewServer(turn.ServerConfig{Realm: "d22.handoff.test", AuthHandler: func(*turn.RequestAttributes) (string, []byte, bool) { return "", nil, false }, PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: socket, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1"}}}})
	if err != nil {
		socket.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { stun.Close() })
	lease := ticket.Lease
	options := peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: socket.LocalAddr().String(), LocalDeviceID: lease.FromDeviceID, PeerDeviceID: lease.ToDeviceID, PrivateKey: manager.config.PrivateKey, PeerKey: remotePublic, ServiceKey: manager.config.Authority.PublicKey, Scope: protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}, Revision: lease.Revision, Lease: lease, Ticket: &ticket}
	connection.transport, err = peer.NewTransport(manager.ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	options.LocalDeviceID, options.PeerDeviceID = lease.ToDeviceID, lease.FromDeviceID
	options.PrivateKey, options.PeerKey = remotePrivate, manager.config.Device.PublicKey
	remote, err := peer.NewTransport(manager.ctx, options)
	if err != nil {
		connection.transport.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCandidateTransport(t, connection)
		remote.Close()
		if connection.mux != nil {
			connection.mux.Close()
		}
	})
	if !connect {
		return manager, connection, ticket, remote
	}
	ctx, cancel := context.WithTimeout(manager.ctx, 3*time.Second)
	defer cancel()
	offer, err := connection.transport.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := remote.AcceptOffer(ctx, offer)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.transport.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, transport := range []*peer.Transport{connection.transport, remote} {
		if err := transport.WaitReady(ctx); err != nil {
			t.Fatal(err)
		}
	}
	connection.mux, err = peer.NewMux(connection.transport, peer.StreamScope{AttemptID: lease.AttemptID, Generation: lease.Generation, Initiator: true})
	if err != nil {
		t.Fatal(err)
	}
	connection.result.State = State{PairID: connection.PairID, AttemptID: lease.AttemptID, Generation: lease.Generation, Stage: "starting-runtime"}
	return manager, connection, ticket, remote
}

func committedHandoffState(ticket protocol.CandidateTicket) protocol.CandidateState {
	state := pendingCandidateState(ticket)
	state.FromReady, state.ToReady = true, true
	state.Decision.Status, state.Decision.DecidedAt = "committed", time.Now().Unix()
	state.CurrentActiveAttemptID, state.CurrentActiveGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	return state
}

func TestCandidateHandoffReadyReceiptUsesOneReadyOneCommitZeroState(t *testing.T) {
	var ticket protocol.CandidateTicket
	var ready, commit, reads atomic.Int32
	manager, connection, signed := liveCandidateHandoffFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var action protocol.CandidateAction
		if r.URL.Path != "/v2/candidates/state" && (json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket) {
			t.Error("handoff changed exact immutable action")
		}
		state := pendingCandidateState(ticket)
		state.FromReady, state.ToReady = true, true
		switch r.URL.Path {
		case "/v2/candidates/ready":
			ready.Add(1)
		case "/v2/candidates/commit":
			commit.Add(1)
			state = committedHandoffState(ticket)
		case "/v2/candidates/state":
			reads.Add(1)
		default:
			t.Error("unexpected handoff control request", r.URL.Path)
		}
		json.NewEncoder(w).Encode(state)
	}))
	ticket = signed
	observer := manager.startCandidateDecisionObserver(connection)
	if observer.stop() {
		t.Fatal("idle observer invented unknown Cancel")
	}
	// Count window begins only after observer join; setup does not issue State.
	if err := manager.readyAndResolveCandidate(connection, true); err != nil {
		t.Fatal(err)
	}
	if !manager.isPromoted(connection) || ready.Load() != 1 || commit.Load() != 1 || reads.Load() != 0 {
		t.Fatalf("after joined handoff Ready=%d Commit=%d State=%d promoted=%t", ready.Load(), commit.Load(), reads.Load(), manager.isPromoted(connection))
	}
	t.Logf("handoff-count-window observerJoined=true Ready=%d Commit=%d State=%d promoted=%t", ready.Load(), commit.Load(), reads.Load(), manager.isPromoted(connection))
	if *connection.ticket != ticket || connection.ticket.PrepareDeadline != signed.PrepareDeadline {
		t.Fatal("handoff changed immutable deadline/ticket")
	}
}

func TestCandidateHandoffCancelsAndJoinsBlockedObserverStateOnly(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	manager, connection, _ := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/candidates/state" {
			t.Error("observer dispatched mutation")
			return
		}
		io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(func() { close(release) })
	observer := manager.startCandidateDecisionObserver(connection)
	connection.notify()
	select {
	case <-entered:
	case <-manager.ctx.Done():
		t.Fatal("observer did not enter State")
	}
	joined := make(chan bool, 1)
	go func() { joined <- observer.stop() }()
	select {
	case unknown := <-joined:
		if unknown || connection.ctx.Err() != nil || manager.ctx.Err() != nil {
			t.Fatal("observer stop cancelled its candidate/Manager or invented mutation")
		}
	case <-manager.ctx.Done():
		t.Fatal("handoff failed to cancel/join blocked observer State")
	}
}
