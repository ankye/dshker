package peersession

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/pion/turn/v5"
)

func candidateTransportKey(t *testing.T, manager *Manager, connection *session) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manager.config.PrivateKey = private
	manager.config.Device.PublicKey = public
	manager.config.Endpoints.STUNAddress = "127.0.0.1:3478"
	pin := manager.pins[connection.PairID]
	pin.Initiator.PublicKey = public
	manager.pins[connection.PairID] = pin
}

func closeCandidateTransport(t *testing.T, connection *session) {
	t.Helper()
	connection.cancel()
	if connection.transport != nil {
		connection.transport.Close()
	}
	if connection.signalDone != nil {
		<-connection.signalDone
	}
}

func TestCreateCandidateTransportRetriesTURNWithSameTicketAndActualRelayCredentials(t *testing.T) {
	for _, code := range []string{"p2p.rate_limited", "p2p.server_unavailable"} {
		t.Run(code, func(t *testing.T) {
			socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			username := fmt.Sprintf("%d:aaaaaaaaaaaa", time.Now().Add(time.Hour).Unix())
			const password, realm = "candidate-relay-credential", "dshker.candidate.test"
			var authenticated atomic.Int32
			relay, err := turn.NewServer(turn.ServerConfig{Realm: realm, AuthHandler: func(attributes *turn.RequestAttributes) (string, []byte, bool) {
				if attributes.Username != username || attributes.Realm != realm {
					return "", nil, false
				}
				authenticated.Add(1)
				return username, turn.GenerateAuthKey(username, realm, password), true
			}, PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: socket, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1"}}}})
			if err != nil {
				socket.Close()
				t.Fatal(err)
			}
			t.Cleanup(func() { relay.Close() })
			var requests atomic.Int32
			manager, connection, ticket := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/turn-credentials" {
					t.Error("TURN preparation changed control operation", r.URL.Path)
					return
				}
				if requests.Add(1) == 1 {
					w.WriteHeader(429)
					json.NewEncoder(w).Encode(map[string]string{"code": code})
					return
				}
				json.NewEncoder(w).Encode(controlplane.TurnCredentials{URLs: []string{"turn:" + socket.LocalAddr().String()}, Username: username, Credential: password})
			}))
			candidateTransportKey(t, manager, connection)
			manager.config.Endpoints.STUNAddress = socket.LocalAddr().String()
			if err := manager.createCandidateTransport(connection); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { closeCandidateTransport(t, connection) })
			if requests.Load() != 2 || *connection.ticket != ticket || connection.lease != ticket.Lease || manager.candidates[connection.PairID] != connection {
				t.Fatal("TURN retry changed candidate/lease or released its slot")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			offer, err := connection.transport.Offer(ctx)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := base64.RawURLEncoding.DecodeString(offer.Payload)
			var sdp protocol.SDP
			if err != nil || json.Unmarshal(payload, &sdp) != nil || !strings.Contains(sdp.SDP, " typ relay ") || authenticated.Load() == 0 || offer.AttemptID != ticket.Lease.AttemptID {
				t.Fatal("created transport did not authenticate/allocate the issued TURN relay")
			}
		})
	}
}

func TestCreateCandidateTransportOnlyExplicitUnconfiguredRelayAllowsDirect(t *testing.T) {
	for _, kind := range []string{"unconfigured", "unauthorized", "bad-request", "missing-field", "empty-credential", "empty-urls", "non-turn-url", "foreign-device"} {
		t.Run(kind, func(t *testing.T) {
			var requests atomic.Int32
			manager, connection, ticket := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				codes := map[string]string{"unconfigured": "p2p.relay_unconfigured", "unauthorized": "p2p.user_unauthorized", "bad-request": "p2p.invalid_request"}
				if code := codes[kind]; code != "" {
					w.WriteHeader(http.StatusBadRequest)
					json.NewEncoder(w).Encode(map[string]string{"code": code})
					return
				}
				if kind == "missing-field" {
					w.Write([]byte(`{"urls":[]}`))
					return
				}
				creds := controlplane.TurnCredentials{URLs: []string{"turn:127.0.0.1:3478"}, Username: fmt.Sprintf("%d:aaaaaaaaaaaa", time.Now().Add(time.Hour).Unix()), Credential: "credential"}
				switch kind {
				case "empty-credential":
					creds.Credential = ""
				case "empty-urls":
					creds.URLs = []string{}
				case "non-turn-url":
					creds.URLs[0] = "stun:127.0.0.1:3478"
				case "foreign-device":
					creds.Username = fmt.Sprintf("%d:cccccccccccc", time.Now().Add(time.Hour).Unix())
				}
				json.NewEncoder(w).Encode(creds)
			}))
			candidateTransportKey(t, manager, connection)
			err := manager.createCandidateTransport(connection)
			if kind == "unconfigured" {
				if err != nil || connection.transport == nil {
					t.Fatal("explicit STUN-only mode was rejected", err)
				}
				closeCandidateTransport(t, connection)
			} else if err == nil || connection.transport != nil {
				t.Fatal("real TURN refusal silently created direct-only transport", err)
			}
			if requests.Load() != 1 || *connection.ticket != ticket || manager.candidates[connection.PairID] != connection {
				t.Fatal("terminal/direct-mode response changed candidate or retried")
			}
		})
	}
}

func TestCreateCandidateTransportRespectsOriginalLeaseDeadline(t *testing.T) {
	var requests atomic.Int32
	manager, fence, key := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(429)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
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
	ticket.Lease.ExpiresAt = time.Now().Add(time.Second).Unix()
	ticket.PrepareDeadline = ticket.Lease.ExpiresAt
	ticket.Lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, ticket.Lease.SigningBytes()))
	ticket.Sign(key)
	if err := manager.installCandidateTicket(connection, ticket); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = manager.createCandidateTransport(connection)
	if err == nil || err.Error() != "p2p.lease_expired" || time.Since(started) > 2*time.Second || requests.Load() == 0 || connection.transport != nil || *connection.ticket != ticket {
		t.Fatal("TURN retry extended original admission deadline", err)
	}
	manager.finish(connection.PairID, connection)
}

func TestInboundTURNWaitDoesNotBlockSignalsAndCloseJoinsItsStartupOwner(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	manager, fence, key := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(func() { close(release) })
	_, pin := pinFixture()
	request := protocol.PrepareCandidate{AttemptID: protocol.NewNonce(), Registration: fence, UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID, Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	ticket := signedCandidate(request, pin.Target.DeviceID, protocol.NewNonce(), key)
	active, _ := manager.signals.current()
	started := time.Now()
	if !manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate", Ticket: ticket}) || time.Since(started) > time.Second {
		t.Fatal("TURN startup blocked subscription delivery")
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("inbound startup did not request TURN")
	}
	manager.mu.Lock()
	connection := manager.inboundCandidates[pin.Pair.PairID]
	manager.mu.Unlock()
	if connection == nil {
		t.Fatal("inbound startup lost its joinable session owner")
	}
	manager.receiveControl(active, controlplane.SignalEvent{Type: "signal", Ticket: ticket, Signal: protocol.Signal{AttemptID: ticket.Lease.AttemptID, Type: "offer"}})
	if len(connection.signalInbox) != 1 {
		t.Fatal("already-admitted early offer was dropped during TURN wait")
	}
	manager.Close()
	select {
	case <-connection.done:
	default:
		t.Fatal("Close returned before inbound TURN startup joined")
	}
}

func TestTURNWaitCancellationResolvesExactTicketBeforeReleasingSlot(t *testing.T) {
	entered := make(chan struct{}, 1)
	var ticket protocol.CandidateTicket
	var cancelled atomic.Int32
	manager, connection, signed := preparedCandidateFor(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/turn-credentials":
			select {
			case entered <- struct{}{}:
			default:
			}
			w.WriteHeader(429)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
		case "/v2/candidates/cancel":
			var action protocol.CandidateAction
			if json.NewDecoder(r.Body).Decode(&action) != nil || action.Ticket != ticket {
				t.Error("TURN cancellation changed exact ticket")
			}
			cancelled.Add(1)
			state := pendingCandidateState(ticket)
			state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
			json.NewEncoder(w).Encode(state)
		case "/v2/end":
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: ticket.Lease.AttemptID, Generation: ticket.Lease.Generation, Ended: true, Reason: "failed"})
		default:
			t.Error("unexpected TURN cancellation operation", r.URL.Path)
		}
	}))
	ticket = signed
	go func() {
		err := manager.createCandidateTransport(connection)
		manager.failUnstartedCandidate(connection, err)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("candidate did not enter TURN wait")
	}
	connection.requestCancel()
	select {
	case <-connection.done:
	case <-time.After(time.Second):
		t.Fatal("TURN wait ignored exact cancellation")
	}
	<-connection.ready
	connection.mu.Lock()
	refusal := connection.err
	connection.mu.Unlock()
	if cancelled.Load() != 1 || connection.transport != nil || refusal == nil || refusal.Error() != "p2p.candidate_cancelled" || *connection.ticket != ticket {
		t.Fatal("TURN wait discarded cancellation authority or started a transport")
	}
}
