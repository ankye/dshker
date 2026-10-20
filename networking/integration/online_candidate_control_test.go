//go:build live

package integration

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

type onlineCandidateSocket struct {
	connection *websocket.Conn
	transport  *http.Transport
	ready      protocol.ControlReady
	events     chan []byte
	done       chan struct{}
	cancel     context.CancelFunc
	once       sync.Once
}

func (socket *onlineCandidateSocket) close() {
	socket.once.Do(func() {
		socket.cancel()
		socket.connection.CloseNow()
		<-socket.done
		socket.transport.CloseIdleConnections()
	})
}

// This test-only wire observer proves actual HTTP 101 and the complete v2 ready
// identity, neither of which is exposed by the production Signals accessor.
// Production Host/Manager admission is exercised separately in the same test.
func onlineCandidateSubscribe(t *testing.T, ctx context.Context, f *onlineCandidateFixture, index int, coreID string, capabilities []string) *onlineCandidateSocket {
	t.Helper()
	config := f.config[index]
	certificate := tls.Certificate{Certificate: [][]byte{config.Device.Certificate}, PrivateKey: config.Private}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{certificate}}, MaxResponseHeaderBytes: 16 * 1024}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	connection, response, err := websocket.Dial(ctx, f.endpoints.WSSURL, &websocket.DialOptions{HTTPClient: client, Subprotocols: []string{protocol.ControlSubprotocol}})
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		transport.CloseIdleConnections()
		onlineCandidateMust(t, "mtls-wss-upgrade", err)
	}
	t.Cleanup(func() { connection.CloseNow() })
	if response == nil || response.StatusCode != http.StatusSwitchingProtocols || response.TLS == nil || len(response.TLS.VerifiedChains) == 0 || connection.Subprotocol() != protocol.ControlSubprotocol {
		connection.CloseNow()
		transport.CloseIdleConnections()
		t.Fatal("mTLS WSS did not prove HTTP101, system trust and exact v2 subprotocol")
	}
	connection.SetReadLimit(protocol.MaxControlBytes)
	hello := protocol.ControlHello{Version: protocol.ControlVersion, Type: "hello", UserID: f.userSession.User.UserID, CoreInstanceID: coreID, Capabilities: capabilities}
	encoded, err := json.Marshal(hello)
	onlineCandidateMust(t, "control-hello-encode", err)
	onlineCandidateMust(t, "control-hello-write", connection.Write(ctx, websocket.MessageText, encoded))
	kind, data, err := connection.Read(ctx)
	onlineCandidateMust(t, "control-ready-read", err)
	var ready protocol.ControlReady
	onlineCandidateMust(t, "control-ready-decode", protocol.DecodeControl(data, &ready))
	if kind != websocket.MessageText || !onlineCandidateReadyValid(ready, config.Device.DeviceID, f.userSession.User.UserID, coreID) {
		connection.CloseNow()
		transport.CloseIdleConnections()
		t.Fatal("v2 ready did not bind this run's current user, device, core and registration fence")
	}
	lifetime, cancel := context.WithCancel(ctx)
	socket := &onlineCandidateSocket{connection: connection, transport: transport, ready: ready, events: make(chan []byte, 64), done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(socket.done)
		defer close(socket.events)
		for {
			kind, data, err := connection.Read(lifetime)
			if err != nil || kind != websocket.MessageText {
				return
			}
			select {
			case socket.events <- bytes.Clone(data):
			case <-lifetime.Done():
				return
			}
		}
	}()
	t.Cleanup(socket.close)
	t.Logf("online-wss status=101 device=%s user=%s core=%s serverEpoch=%s subscription=%s candidateAdvertised=%t", ready.DeviceID, ready.UserID, ready.Registration.CoreInstanceID, ready.Registration.ServerEpoch, ready.Registration.SubscriptionID, len(capabilities) > 0)
	return socket
}

func onlineCandidateReadyValid(ready protocol.ControlReady, deviceID, userID, coreID string) bool {
	// Ready advertises server support, not an echo of Hello capabilities. The
	// frozen server advertises candidate support even to a read-only Hello=[];
	// only its stored per-device Hello gates Prepare. Production Signals has
	// this same server-support check for SubscribeControlReadOnly.
	return ready.Version == protocol.ControlVersion && ready.Type == "ready" && ready.DeviceID == deviceID && ready.UserID == userID && ready.Registration.Valid() && ready.Registration.CoreInstanceID == coreID && protocol.ValidControlCapabilities(ready.Capabilities) && protocol.HasCapability(ready.Capabilities, protocol.CapabilityCandidate)
}

func onlineCandidateRefused(t *testing.T, operation, expected string, err error) {
	t.Helper()
	code, typed := protocol.Refusal(err)
	if !typed || code != expected || err.Error() != code {
		t.Fatalf("online authorization operation=%s expected=%s actual=%s typed=%t", operation, expected, hostColdError(err), typed)
	}
	t.Logf("online-authorization operation=%s code=%s", operation, code)
}

func onlineCandidatePin(t *testing.T, f *onlineCandidateFixture, identity controlplane.PairIdentity) {
	t.Helper()
	if identity.Pair != f.pair || identity.Initiator.DeviceID != f.config[0].Device.DeviceID || identity.Target.DeviceID != f.config[1].Device.DeviceID || identity.Initiator.UserID != f.userSession.User.UserID || identity.Target.UserID != f.userSession.User.UserID || !bytes.Equal(identity.Initiator.PublicKey, f.config[0].Device.PublicKey) || !bytes.Equal(identity.Target.PublicKey, f.config[1].Device.PublicKey) {
		t.Fatal("fresh scoped v2 identity changed pair, account, network, devices or generated keys")
	}
}

func onlineCandidateReceipt(t *testing.T, f *onlineCandidateFixture, ticket protocol.CandidateTicket, state protocol.CandidateState, status string, fromReady, toReady, active bool) {
	t.Helper()
	onlineCandidateMust(t, "receipt-ticket-signature", ticket.Verify(f.authority.PublicKey))
	onlineCandidateMust(t, "receipt-decision-lease", state.Decision.Lease.VerifyCandidateScope(f.authority.PublicKey, ticket))
	onlineCandidateMust(t, "receipt-latest-lease", state.LatestLease.VerifyCandidateScope(f.authority.PublicKey, ticket))
	if state.Ticket != ticket || state.Decision.Status != status || state.Decision.Reason != "" || state.FromReady != fromReady || state.ToReady != toReady || (status == "pending" && state.Decision.DecidedAt != 0) || (status == "committed" && state.Decision.DecidedAt <= 0) {
		t.Fatal("candidate receipt changed immutable ticket, decision or participant readiness")
	}
	wantAttempt, wantGeneration := "", uint64(0)
	if active {
		wantAttempt, wantGeneration = ticket.Lease.AttemptID, ticket.Lease.Generation
	}
	if state.CurrentActiveAttemptID != wantAttempt || state.CurrentActiveGeneration != wantGeneration {
		t.Fatal("candidate receipt aliased the exact current active directed slot")
	}
}

func onlineCandidateLifecycle(t *testing.T, ctx context.Context, f *onlineCandidateFixture) {
	t.Helper()
	cores := [2]string{integrationCoreInstanceID(t), integrationCoreInstanceID(t)}
	var sockets [2]*onlineCandidateSocket
	for index := range sockets {
		sockets[index] = onlineCandidateSubscribe(t, ctx, f, index, cores[index], []string{})
		identity, err := f.devices[index].ScopedPairIdentity(ctx, protocol.PairIdentityRequest{Registration: sockets[index].ready.Registration, UserID: f.userSession.User.UserID, NetworkID: f.network.NetworkID, PairID: f.pair.PairID})
		onlineCandidateMust(t, "read-only-fresh-scoped-pair", err)
		onlineCandidatePin(t, f, identity)
		f.config[index].Pin = identity
	}
	prepare := protocol.PrepareCandidate{Registration: sockets[0].ready.Registration, AttemptID: protocol.NewNonce(), UserID: f.userSession.User.UserID, NetworkID: f.network.NetworkID, PairID: f.config[1].Device.DeviceID, Generation: 1, ToCoreInstanceID: cores[1]}
	_, err := f.devices[0].PrepareCandidate(ctx, prepare)
	onlineCandidateRefused(t, "read-only-prepare", "p2p.candidate_unsupported", err)
	for index := range sockets {
		old := sockets[index].ready.Registration
		sockets[index].close()
		sockets[index] = onlineCandidateSubscribe(t, ctx, f, index, cores[index], []string{protocol.CapabilityCandidate})
		fresh := sockets[index].ready.Registration
		if fresh.CoreInstanceID != old.CoreInstanceID || fresh.ServerEpoch != old.ServerEpoch || fresh.SubscriptionID == old.SubscriptionID {
			t.Fatal("capability activation did not retain core/epoch and mint a fresh subscription fence")
		}
	}
	defer sockets[0].close()
	defer sockets[1].close()
	prepare.Registration = sockets[0].ready.Registration
	prepare.AttemptID = protocol.NewNonce()
	linkRequest := protocol.LinkStateRequest{Registration: prepare.Registration, UserID: prepare.UserID, NetworkID: prepare.NetworkID, PairID: prepare.PairID}
	link, err := f.devices[0].LinkState(ctx, linkRequest)
	onlineCandidateMust(t, "empty-directed-slot", err)
	if link.ServerEpoch != prepare.Registration.ServerEpoch || link.PeerCoreInstanceID != cores[1] || link.CurrentActiveAttemptID != "" || link.CurrentActiveGeneration != 0 || !protocol.HasCapability(link.PeerCapabilities, protocol.CapabilityCandidate) {
		t.Fatal("fresh link did not identify the current remote core and empty active slot")
	}
	wrongUser := protocol.PairIdentityRequest{Registration: prepare.Registration, UserID: protocol.NewID(), NetworkID: f.network.NetworkID, PairID: f.pair.PairID}
	_, err = f.devices[0].ScopedPairIdentity(ctx, wrongUser)
	onlineCandidateRefused(t, "foreign-selected-user", "p2p.user_unauthorized", err)
	stale := linkRequest
	stale.Registration.SubscriptionID = protocol.NewNonce()
	_, err = f.devices[0].LinkState(ctx, stale)
	onlineCandidateRefused(t, "stale-subscription-fence", "p2p.registration_stale", err)
	ticket, err := f.devices[0].PrepareCandidate(ctx, prepare)
	onlineCandidateMust(t, "prepare-candidate", err)
	onlineCandidateMust(t, "signed-candidate-ticket", ticket.Verify(f.authority.PublicKey))
	lease := ticket.Lease
	if ticket.ServerEpoch != prepare.Registration.ServerEpoch || ticket.FromCoreInstanceID != cores[0] || ticket.ToCoreInstanceID != cores[1] || ticket.PreviousAttemptID != "" || ticket.PreviousGeneration != 0 || lease.ServiceID != f.authority.ServiceID || lease.UserID != prepare.UserID || lease.NetworkID != prepare.NetworkID || lease.PairID != prepare.PairID || lease.AttemptID != prepare.AttemptID || lease.Generation != prepare.Generation || lease.Revision != 1 || lease.FromDeviceID != f.config[0].Device.DeviceID || lease.ToDeviceID != f.config[1].Device.DeviceID {
		t.Fatal("prepared signed ticket changed exact registration, pair, device or generation scope")
	}
	onlineCandidatePreparedEvent(t, ctx, sockets[1], ticket)
	busy := prepare
	busy.AttemptID, busy.Generation = protocol.NewNonce(), 2
	_, err = f.devices[0].PrepareCandidate(ctx, busy)
	onlineCandidateRefused(t, "unique-prepared-slot", "p2p.connection_busy", err)
	source := protocol.CandidateAction{Registration: sockets[0].ready.Registration, Ticket: ticket}
	target := protocol.CandidateAction{Registration: sockets[1].ready.Registration, Ticket: ticket}
	state, err := f.devices[0].ReadyCandidate(ctx, source)
	onlineCandidateMust(t, "source-ready", err)
	onlineCandidateReceipt(t, f, ticket, state, "pending", true, false, false)
	state, err = f.devices[1].ReadyCandidate(ctx, target)
	onlineCandidateMust(t, "target-ready", err)
	onlineCandidateReceipt(t, f, ticket, state, "pending", true, true, false)
	_, err = f.devices[1].CommitCandidate(ctx, target)
	onlineCandidateRefused(t, "target-cannot-commit", "p2p.source_required", err)
	committed, err := f.devices[0].CommitCandidate(ctx, source)
	onlineCandidateMust(t, "source-commit", err)
	onlineCandidateReceipt(t, f, ticket, committed, "committed", true, true, true)
	renewed, err := f.devices[0].RenewCandidate(ctx, source)
	onlineCandidateMust(t, "current-candidate-lease", err)
	onlineCandidateMust(t, "renewed-signed-lease-scope", renewed.VerifyCandidate(f.authority.PublicKey, ticket, time.Now()))
	request := protocol.CandidateStateRequest{Registration: source.Registration, AttemptID: lease.AttemptID, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.PairID}
	state, err = f.devices[0].CandidateState(ctx, request)
	onlineCandidateMust(t, "committed-state-readback", err)
	onlineCandidateReceipt(t, f, ticket, state, "committed", true, true, true)
	if state.Decision != committed.Decision || state.LatestLease != renewed {
		t.Fatal("readback changed immutable commit decision or lost latest signed renewal")
	}
	ended, err := f.devices[0].EndCandidate(ctx, protocol.EndCandidate{Registration: source.Registration, Ticket: ticket, Reason: "retired"})
	onlineCandidateMust(t, "end-exact-current-candidate", err)
	if !ended.Ended || ended.AttemptID != lease.AttemptID || ended.Generation != lease.Generation || ended.Reason != "retired" || ended.CurrentActiveAttemptID != "" || ended.CurrentActiveGeneration != 0 {
		t.Fatal("end did not retire only the exact current candidate slot")
	}
	state, err = f.devices[0].CandidateState(ctx, request)
	onlineCandidateMust(t, "terminal-decision-readback", err)
	onlineCandidateReceipt(t, f, ticket, state, "committed", true, true, false)
	if state.Decision != committed.Decision {
		t.Fatal("ending authority rewrote the immutable committed decision")
	}
	link, err = f.devices[0].LinkState(ctx, linkRequest)
	onlineCandidateMust(t, "ended-directed-slot-readback", err)
	if link.CurrentActiveAttemptID != "" || link.CurrentActiveGeneration != 0 || link.PeerCoreInstanceID != cores[1] {
		t.Fatal("ended candidate retained active authority or replaced remote core identity")
	}
	t.Logf("online-candidate-lifecycle proof=control-protocol-claims localResourcesProved=false service=%s user=%s network=%s pair=%s attempt=%s generation=%d sourceCore=%s targetCore=%s exactSignedTicket=true sourceCommit=true uniqueSlot=true endReadback=true", f.authority.ServiceID, lease.UserID, lease.NetworkID, lease.PairID, lease.AttemptID, lease.Generation, cores[0], cores[1])
}

func onlineCandidatePreparedEvent(t *testing.T, ctx context.Context, socket *onlineCandidateSocket, ticket protocol.CandidateTicket) {
	t.Helper()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("target did not receive its exact candidate event within the original deadline")
		case data, open := <-socket.events:
			if !open {
				t.Fatal("target's current mTLS WSS closed before candidate delivery")
			}
			var header struct {
				Type string `json:"type"`
			}
			onlineCandidateMust(t, "candidate-event-header", json.Unmarshal(data, &header))
			if header.Type != "candidate" {
				continue
			}
			var event protocol.CandidatePreparedEvent
			onlineCandidateMust(t, "candidate-event-decode", protocol.DecodeControl(data, &event))
			if event.Version != protocol.ControlVersion || event.Ticket != ticket {
				t.Fatal("target WSS candidate event changed the immutable signed ticket")
			}
			return
		}
	}
}
