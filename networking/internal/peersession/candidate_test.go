package peersession

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type candidateSubscription struct {
	*fakeSubscription
	fence protocol.RegistrationFence
}

func candidateSubscriptionFor(coreID string) *candidateSubscription {
	return &candidateSubscription{fakeSubscription: newFakeSubscription(), fence: protocol.RegistrationFence{ServerEpoch: protocol.NewNonce(), SubscriptionID: protocol.NewNonce(), CoreInstanceID: coreID}}
}

func (subscription *candidateSubscription) Registration() (protocol.RegistrationFence, error) {
	return subscription.fence, nil
}
func (subscription *candidateSubscription) SendCandidate(ctx context.Context, _ protocol.CandidateTicket, signal protocol.Signal) error {
	return subscription.Send(ctx, signal)
}

func controlCandidateManager(t *testing.T, handler http.Handler) (*Manager, protocol.RegistrationFence, ed25519.PrivateKey) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := controlplane.New(controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/signals", STUNAddress: "127.0.0.1:3478"}, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	manager, pin := pinFixture()
	manager.ctx, manager.cancel = context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(manager.cancel)
	manager.client = client
	manager.config.CoreInstanceID = protocol.NewNonce()
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manager.config.Authority.PublicKey = public
	manager.config.Authority.ServiceID = protocol.KeyID(public)
	manager.client.SetAccount(pin.Initiator.UserID)
	manager.sessions, manager.inbound = make(map[string]*session), make(map[string]*session)
	manager.candidates, manager.inboundCandidates = make(map[string]*session), make(map[string]*session)
	manager.emit = func(State) {}
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	active := candidateSubscriptionFor(manager.config.CoreInstanceID)
	manager.signals = &signaling{active: active, ctx: manager.ctx, cancel: manager.cancel}
	t.Cleanup(active.Close)
	return manager, active.fence, key
}

func signedCandidate(request protocol.PrepareCandidate, from, fromCore string, key ed25519.PrivateKey) protocol.CandidateTicket {
	lease := protocol.Lease{Version: 1, ServiceID: protocol.KeyID(key.Public().(ed25519.PublicKey)), UserID: request.UserID, NetworkID: request.NetworkID, PairID: request.PairID, AttemptID: request.AttemptID, FromDeviceID: from, ToDeviceID: request.PairID, Generation: request.Generation, Revision: 1, ExpiresAt: time.Now().Add(time.Minute).Unix(), Permission: "dsh-session"}
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, lease.SigningBytes()))
	ticket := protocol.CandidateTicket{Version: 1, Lease: lease, ServerEpoch: request.Registration.ServerEpoch, PreviousAttemptID: request.PreviousAttemptID, PreviousGeneration: request.PreviousGeneration, FromCoreInstanceID: fromCore, ToCoreInstanceID: request.ToCoreInstanceID, PrepareDeadline: time.Now().Add(2 * time.Minute).Unix()}
	ticket.Sign(key)
	return ticket
}

func TestMalformedPrepareReplyResolvesExactAttemptWithoutDiscardingSlot(t *testing.T) {
	var manager *Manager
	var fence protocol.RegistrationFence
	var key ed25519.PrivateKey
	var ticket protocol.CandidateTicket
	var prepareCalls atomic.Int32
	manager, fence, key = controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: strings.Repeat("a", 32), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			var request protocol.PrepareCandidate
			json.NewDecoder(r.Body).Decode(&request)
			ticket = signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
			prepareCalls.Add(1)
			w.Write([]byte(`{"version":1}`))
		case "/v2/candidates/state":
			json.NewEncoder(w).Encode(protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: ticket.Lease}, LatestLease: ticket.Lease})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.prepareCandidate(connection); err != nil {
		t.Fatal(err)
	}
	if prepareCalls.Load() != 1 || connection.ticket == nil || connection.ticket.Lease.AttemptID != connection.prepare.AttemptID || manager.candidates[connection.PairID] != connection {
		t.Fatal("unknown prepare outcome lost or changed the reserved id")
	}
	manager.finish(connection.PairID, connection)
}

func TestStaleSubscriptionAndWrongAccountCannotAdmitCandidate(t *testing.T) {
	manager, fence, key := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	old := candidateSubscriptionFor(manager.config.CoreInstanceID)
	defer old.Close()
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(), UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID, Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	ticket := signedCandidate(request, pin.Target.DeviceID, protocol.NewNonce(), key)
	manager.receiveControl(old, controlplane.SignalEvent{Type: "candidate", Ticket: ticket})
	if len(manager.inboundCandidates) != 0 {
		t.Fatal("old subscription admitted a staged candidate")
	}
	ticket.Lease.UserID = "ffffffffffff"
	ticket.Lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, ticket.Lease.SigningBytes()))
	ticket.Sign(key)
	manager.acceptCandidate(ticket)
	if len(manager.inboundCandidates) != 0 {
		t.Fatal("a server-signed ticket for another account reached runtime admission")
	}
}

func TestDisconnectResolvesDispatchedPrepareBeforeReleasingCandidateSlot(t *testing.T) {
	var manager *Manager
	var fence protocol.RegistrationFence
	var key ed25519.PrivateKey
	var ticket protocol.CandidateTicket
	entered, release := make(chan struct{}), make(chan struct{})
	var cancelled atomic.Bool
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
			json.NewEncoder(w).Encode(protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: ticket.Lease}, LatestLease: ticket.Lease})
		case "/v2/candidates/cancel":
			cancelled.Store(true)
			json.NewEncoder(w).Encode(protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "cancelled", Reason: "p2p.connection_cancelled", DecidedAt: time.Now().Unix(), Lease: ticket.Lease}, LatestLease: ticket.Lease})
		case "/v2/end":
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: ticket.Lease.AttemptID, Generation: ticket.Lease.Generation, Ended: true, Reason: "failed"})
		default:
			t.Errorf("unexpected operation %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	_, pin := pinFixture()
	connected := make(chan error, 1)
	go func() { _, err := manager.Connect(manager.ctx, pin.Pair.PairID, 1, true); connected <- err }()
	<-entered
	manager.mu.Lock()
	connection := manager.candidates[pin.Pair.PairID]
	manager.mu.Unlock()
	if _, err := manager.Connect(manager.ctx, pin.Pair.PairID, 2, true); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("unknown prepare lost its unique slot", err)
	}
	disconnected := make(chan error, 1)
	go func() { disconnected <- manager.Disconnect(pin.Pair.PairID) }()
	<-connection.ctx.Done()
	manager.mu.Lock()
	retained := manager.candidates[pin.Pair.PairID] == connection
	manager.mu.Unlock()
	if !retained {
		t.Fatal("HTTP cancellation discarded an admitted unknown prepare")
	}
	close(release)
	select {
	case err := <-disconnected:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("disconnect did not resolve the exact candidate")
	}
	if !cancelled.Load() || connection.transport != nil {
		t.Fatal("disconnect did not cancel admission before runtime/transport work")
	}
	if err := <-connected; err == nil {
		t.Fatal("cancelled prepare was reported as connected")
	}
}

func TestRevocationBetweenLinkStateAndPrepareConvergesDuringDisconnect(t *testing.T) {
	for _, code := range []string{"p2p.binding_unauthorized", "p2p.network_unauthorized", "p2p.pair_revoked"} {
		t.Run(code, func(t *testing.T) {
			var fence protocol.RegistrationFence
			entered, release := make(chan struct{}), make(chan struct{})
			manager, current, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/links/state":
					json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: protocol.NewNonce(), PeerCapabilities: []string{protocol.CapabilityCandidate}})
				case "/v2/candidates/prepare":
					close(entered)
					<-release
					w.WriteHeader(http.StatusForbidden)
					json.NewEncoder(w).Encode(map[string]string{"code": code})
				case "/v2/candidates/state":
					w.WriteHeader(http.StatusNotFound)
					json.NewEncoder(w).Encode(map[string]string{"code": "p2p.attempt_not_found"})
				default:
					t.Errorf("rejected admission dispatched another operation: %s", r.URL.Path)
				}
			}))
			fence = current
			_, pin := pinFixture()
			connected := make(chan error, 1)
			go func() { _, err := manager.Connect(manager.ctx, pin.Pair.PairID, 1, true); connected <- err }()
			<-entered
			manager.mu.Lock()
			connection := manager.candidates[pin.Pair.PairID]
			manager.mu.Unlock()
			disconnected := make(chan error, 1)
			go func() { disconnected <- manager.Disconnect(pin.Pair.PairID) }()
			<-connection.ctx.Done()
			close(release)
			select {
			case err := <-connected:
				if err == nil || (err.Error() != code && err.Error() != "p2p.connection_cancelled") {
					t.Fatal("admission refusal lost", err)
				}
			case <-time.After(time.Second):
				t.Fatal("explicit admission refusal remained in unknown resolving")
			}
			select {
			case err := <-disconnected:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("Disconnect waited forever for a candidate never admitted")
			}
			manager.mu.Lock()
			retained := len(manager.candidates)
			manager.mu.Unlock()
			if retained != 0 {
				t.Fatal("refused candidate retained its unique slot")
			}
		})
	}
}

func TestPrepareLivenessFailureCannotDiscardUnknownAdmission(t *testing.T) {
	var manager *Manager
	var fence protocol.RegistrationFence
	var key ed25519.PrivateKey
	var calls int
	var attempt string
	var ticket protocol.CandidateTicket
	manager, fence, key = controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: strings.Repeat("a", 32), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			var request protocol.PrepareCandidate
			json.NewDecoder(r.Body).Decode(&request)
			calls++
			if attempt != "" && attempt != request.AttemptID {
				t.Error("unknown admission changed its id")
			}
			attempt = request.AttemptID
			if calls == 1 {
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]string{"code": "p2p.peer_offline"})
				return
			}
			ticket = signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
			json.NewEncoder(w).Encode(ticket)
		case "/v2/candidates/state":
			if calls > 1 {
				json.NewEncoder(w).Encode(protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: ticket.Lease}, LatestLease: ticket.Lease})
				return
			}
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.peer_offline"})
		}
	}))
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.prepareCandidate(connection); err != nil {
		t.Fatal("liveness error was treated as absence", err)
	}
	if calls != 2 || manager.candidates[pin.Pair.PairID] != connection || connection.ticket == nil || connection.ticket.Lease.AttemptID != attempt {
		t.Fatal("unknown admission was discarded or changed")
	}
	manager.finish(connection.PairID, connection)
}

func TestMalformedStateReadbackRetainsExactUnknownAdmission(t *testing.T) {
	for _, kind := range []string{"ticket-signature", "decision"} {
		t.Run(kind, func(t *testing.T) {
			var manager *Manager
			var fence protocol.RegistrationFence
			var key ed25519.PrivateKey
			var ticket protocol.CandidateTicket
			var reads int
			var attempt string
			manager, fence, key = controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v2/links/state":
					json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: strings.Repeat("a", 32), PeerCapabilities: []string{protocol.CapabilityCandidate}})
				case "/v2/candidates/prepare":
					var request protocol.PrepareCandidate
					json.NewDecoder(r.Body).Decode(&request)
					if attempt != "" && request.AttemptID != attempt {
						t.Error("readback failure reminted admission id")
					}
					attempt = request.AttemptID
					if ticket.Version == 0 {
						ticket = signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
					}
					if reads == 0 {
						w.Write([]byte(`{"version":1}`))
						return
					}
					json.NewEncoder(w).Encode(ticket)
				case "/v2/candidates/state":
					reads++
					state := protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: ticket.Lease}, LatestLease: ticket.Lease}
					if reads == 1 {
						if kind == "ticket-signature" {
							state.Ticket.Signature = "invalid"
						} else {
							state.Decision.Reason = "p2p.invalid_for_pending"
						}
					}
					json.NewEncoder(w).Encode(state)
				}
			}))
			_, pin := pinFixture()
			connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := manager.prepareCandidate(connection); err != nil {
				t.Fatal("bad state reply discarded the admitted id", err)
			}
			if reads != 2 || manager.candidates[connection.PairID] != connection || connection.ticket == nil || *connection.ticket != ticket {
				t.Fatal("unknown state did not retain one slot until valid full readback")
			}
			manager.finish(connection.PairID, connection)
		})
	}
}

func TestInvalidPrepareTicketResolvesAuthoritativeStateByID(t *testing.T) {
	var manager *Manager
	var fence protocol.RegistrationFence
	var key ed25519.PrivateKey
	var ticket protocol.CandidateTicket
	manager, fence, key = controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/links/state":
			json.NewEncoder(w).Encode(protocol.LinkState{ServerEpoch: fence.ServerEpoch, PeerCoreInstanceID: strings.Repeat("a", 32), PeerCapabilities: []string{protocol.CapabilityCandidate}})
		case "/v2/candidates/prepare":
			var request protocol.PrepareCandidate
			json.NewDecoder(r.Body).Decode(&request)
			ticket = signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
			corrupt := ticket
			corrupt.Signature = "invalid-signature"
			json.NewEncoder(w).Encode(corrupt)
		case "/v2/candidates/state":
			json.NewEncoder(w).Encode(protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: ticket.Lease}, LatestLease: ticket.Lease})
		}
	}))
	_, pin := pinFixture()
	connection, err := manager.reserveCandidate(pin.Pair.PairID, 1, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.prepareCandidate(connection); err != nil {
		t.Fatal("invalid reply lost a durably admitted attempt", err)
	}
	if connection.ticket == nil || *connection.ticket != ticket {
		t.Fatal("state-by-id did not recover the exact valid ticket")
	}
	manager.finish(connection.PairID, connection)
}

func TestPeerCoreReplacementSuspendsExactPrimaryWithoutCandidateProjection(t *testing.T) {
	manager, fence, key := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(), UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: pin.Target.DeviceID, Generation: 4, ToCoreInstanceID: protocol.NewNonce()}
	ticket := signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, key)
	primary := newSession(manager.ctx)
	primary.PairID, primary.lease, primary.ticket, primary.promoted = pin.Pair.PairID, ticket.Lease, &ticket, true
	primary.result.State = State{PairID: primary.PairID, AttemptID: ticket.Lease.AttemptID, Generation: 4, RuntimeGeneration: 7, Stage: "ready"}
	manager.sessions[primary.PairID] = primary
	var emitted []State
	manager.emit = func(state State) { emitted = append(emitted, state) }
	wakes := 0
	registrations := make(chan protocol.PeerRegistration, 1)
	manager.config.Wake = func(pairID string) {
		if pairID == primary.PairID {
			wakes++
		}
	}
	manager.config.PeerRegistration = func(received protocol.PeerRegistration) { registrations <- received }
	event := protocol.PeerRegistration{Version: 2, Type: "peer-registration", ServerEpoch: fence.ServerEpoch, DeviceID: pin.Target.DeviceID, UserID: pin.Initiator.UserID, CoreInstanceID: protocol.NewNonce(), Capabilities: []string{protocol.CapabilityCandidate}, Online: true}
	manager.peerRegistration(event)
	select {
	case received := <-registrations:
		if received.Version != event.Version || received.Type != event.Type || received.ServerEpoch != event.ServerEpoch || received.DeviceID != event.DeviceID || received.UserID != event.UserID || received.CoreInstanceID != event.CoreInstanceID || received.Online != event.Online || len(received.Capabilities) != 1 || received.Capabilities[0] != event.Capabilities[0] {
			t.Fatal("accepted coordinator registration was not forwarded unchanged", received)
		}
	case <-time.After(time.Second):
		t.Fatal("accepted coordinator registration did not schedule catalog/directory convergence")
	}
	suspended, err := manager.CurrentState(primary.PairID)
	if err != nil || suspended.Stage != "suspended" || suspended.AttemptID != ticket.Lease.AttemptID || suspended.Generation != 4 || suspended.RuntimeGeneration != 7 || suspended.Error != "" || wakes != 1 {
		t.Fatal("replacement lost the exact primary identity or failed to wake", suspended, err, wakes)
	}
	candidate, err := manager.reserveCandidate(primary.PairID, 5, false, true)
	if err != nil {
		t.Fatal(err)
	}
	manager.candidateProgress(candidate, State{PairID: primary.PairID, AttemptID: candidate.prepare.AttemptID, Generation: 5, Stage: "punching"})
	if current, err := manager.CurrentState(primary.PairID); err != nil || current != suspended || len(emitted) != 1 {
		t.Fatal("candidate progress overwrote the suspended primary", current, err, emitted)
	}
	if manager.OwnsState(State{PairID: primary.PairID, AttemptID: ticket.Lease.AttemptID, Generation: 4, RuntimeGeneration: 7, Stage: "ready"}) {
		t.Fatal("late ready from before replacement regained projection authority")
	}
	manager.finish(candidate.PairID, candidate)
	manager.finish(primary.PairID, primary)
}

func TestAuthoritativeScopeRevocationEndsCancellationWithoutClaimingReceipt(t *testing.T) {
	for _, code := range []string{"p2p.user_unauthorized", "p2p.network_unauthorized", "p2p.binding_unauthorized", "p2p.pair_revoked"} {
		t.Run(code, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			manager, fence, key := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v2/candidates/cancel" {
					close(entered)
					<-release
				}
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"code": code})
			}))
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
			resolved := make(chan error, 1)
			go func() {
				err := manager.resolveCandidateCancellation(connection)
				manager.failUnstartedCandidate(connection, err)
				resolved <- err
			}()
			<-entered
			disconnected := make(chan error, 1)
			go func() { disconnected <- manager.Disconnect(connection.PairID) }()
			<-connection.ctx.Done()
			close(release)
			select {
			case err := <-resolved:
				if err == nil || err.Error() != code {
					t.Fatal("revocation was relabeled as a cancellation receipt", err)
				}
			case <-time.After(time.Second):
				t.Fatal("permanent authorization refusal kept cancellation resolving")
			}
			select {
			case err := <-disconnected:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("Disconnect was pinned by revoked candidate authority")
			}
			if connection.transport != nil || manager.candidates[connection.PairID] != nil {
				t.Fatal("revoked candidate retained resources or slot")
			}
		})
	}
}
