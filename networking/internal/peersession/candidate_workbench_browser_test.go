package peersession

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/coder/websocket"
	"github.com/pion/turn/v5"
)

// These are signed local test receipts, real Pion carriers and HTTP/WS protocol
// oracles. No production coordinator, DSH, OS credential provider or app is used.
type browserCandidateFixture struct {
	manager       *Manager
	fence         protocol.RegistrationFence
	authority     ed25519.PrivateKey
	remotePrivate ed25519.PrivateKey
	remoteCore    string
	stunAddress   string
	pairID        string
}

func newBrowserCandidateFixture(t *testing.T) *browserCandidateFixture {
	t.Helper()
	manager, fence, authority := controlCandidateManager(t, http.NotFoundHandler())
	localPublic, localPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	remotePublic, remotePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, pin := pinFixture()
	pin.Initiator.PublicKey, pin.Target.PublicKey = localPublic, remotePublic
	manager.config.PrivateKey, manager.config.Device.PublicKey = localPrivate, localPublic
	manager.pins[pin.Pair.PairID] = pin
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stun, err := turn.NewServer(turn.ServerConfig{
		Realm: "candidate.workbench.test", AuthHandler: func(*turn.RequestAttributes) (string, []byte, bool) { return "", nil, false },
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: socket, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1"}}},
	})
	if err != nil {
		socket.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { stun.Close() })
	return &browserCandidateFixture{manager: manager, fence: fence, authority: authority, remotePrivate: remotePrivate,
		remoteCore: protocol.NewNonce(), stunAddress: socket.LocalAddr().String(), pairID: pin.Pair.PairID}
}

func (fixture *browserCandidateFixture) prepare(t *testing.T, generation uint64) *session {
	t.Helper()
	manager := fixture.manager
	connection, err := manager.reserveCandidate(fixture.pairID, generation, true, false)
	if err != nil {
		t.Fatal(err)
	}
	request := *connection.prepare
	request.Registration, request.ToCoreInstanceID = fixture.fence, fixture.remoteCore
	if previous := connection.predecessor; previous != nil {
		request.PreviousAttemptID, request.PreviousGeneration = previous.lease.AttemptID, previous.lease.Generation
	}
	connection.prepare = &request
	ticket := signedCandidate(request, manager.config.Device.DeviceID, manager.config.CoreInstanceID, fixture.authority)
	if err := manager.installCandidateTicket(connection, ticket); err != nil {
		t.Fatal(err)
	}
	if connection.lease.FromDeviceID != manager.config.Device.DeviceID || connection.ticket.PreviousAttemptID != request.PreviousAttemptID || connection.ticket.PreviousGeneration != request.PreviousGeneration {
		t.Fatal("browser candidate changed its initiated direction or signed predecessor")
	}
	connection.result.State = State{PairID: connection.PairID, AttemptID: ticket.Lease.AttemptID, Generation: generation, Stage: "starting-runtime"}
	return connection
}

func (fixture *browserCandidateFixture) transports(t *testing.T, connection *session) *peer.Transport {
	t.Helper()
	manager, lease := fixture.manager, connection.lease
	options := peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: fixture.stunAddress,
		LocalDeviceID: lease.FromDeviceID, PeerDeviceID: lease.ToDeviceID, PrivateKey: manager.config.PrivateKey,
		PeerKey: fixture.remotePrivate.Public().(ed25519.PublicKey), ServiceKey: manager.config.Authority.PublicKey,
		Scope:    protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID},
		Revision: lease.Revision, Lease: lease, Ticket: connection.ticket}
	var err error
	connection.transport, err = peer.NewTransport(connection.ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeCandidateTransport(t, connection); manager.finish(connection.PairID, connection) })
	options.LocalDeviceID, options.PeerDeviceID = lease.ToDeviceID, lease.FromDeviceID
	options.PrivateKey, options.PeerKey = fixture.remotePrivate, manager.config.Device.PublicKey
	remote, err := peer.NewTransport(manager.ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { remote.Close() })
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
	if err = connection.transport.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, transport := range []*peer.Transport{connection.transport, remote} {
		if err := transport.WaitReady(ctx); err != nil {
			t.Fatal(err)
		}
	}
	return remote
}

func (fixture *browserCandidateFixture) promote(t *testing.T, generation uint64, binding runtimebridge.Binding, refusal string) *session {
	t.Helper()
	manager := fixture.manager
	connection := fixture.prepare(t, generation)
	remote := fixture.transports(t, connection)
	targetDone := make(chan error, 1)
	go func() {
		owner := func(_ context.Context, deviceID string) (runtimebridge.Binding, error) {
			if deviceID != connection.lease.FromDeviceID {
				return runtimebridge.Binding{}, errors.New("p2p.identity_mismatch")
			}
			if refusal != "" {
				return runtimebridge.Binding{}, errors.New(refusal)
			}
			return binding, nil
		}
		install := func(mux *peer.Mux, value runtimebridge.Binding) (*runtimebridge.Gateway, *runtimebridge.Endpoint, error) {
			return runtimebridge.Attach(manager.ctx, mux, value, false, nil)
		}
		_, endpoint, mux, _, _, err := runtimebridge.Establish(manager.ctx, remote, connection.lease, false, true, false, runtimebridge.WorkbenchOwners{Open: owner}, install)
		if endpoint != nil {
			t.Cleanup(endpoint.Close)
		}
		if mux != nil {
			t.Cleanup(func() { mux.Close() })
		}
		targetDone <- err
	}()
	install := func(mux *peer.Mux, value runtimebridge.Binding) (*runtimebridge.Gateway, *runtimebridge.Endpoint, error) {
		return manager.stageCandidate(connection, mux, value, true)
	}
	_, staged, mux, actual, gotRefusal, err := runtimebridge.Establish(connection.ctx, connection.transport, connection.lease, true, true, false, runtimebridge.WorkbenchOwners{}, install)
	if staged != nil {
		t.Cleanup(staged.Close)
	}
	if mux != nil {
		t.Cleanup(func() { mux.Close() })
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := <-targetDone; err != nil {
		t.Fatal(err)
	}
	if gotRefusal != refusal || actual != binding {
		t.Fatalf("negotiated binding/refusal = %+v, %q; want %+v, %q", actual, gotRefusal, binding, refusal)
	}
	connection.mu.Lock()
	connection.workbenchRefusal, connection.result.State.Error = gotRefusal, gotRefusal
	connection.mu.Unlock()
	if err := manager.probeCandidate(connection); err != nil {
		t.Fatal(err)
	}
	if err := manager.promoteCandidate(connection, committedHandoffState(*connection.ticket), true); err != nil {
		t.Fatal(err)
	}
	return connection
}

func browserWorkbenchRuntime(t *testing.T, body string, requests *atomic.Int32) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/api/remote.mux" {
			connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"127.0.0.1:*"}})
			if err != nil {
				t.Error(err)
				return
			}
			defer connection.CloseNow()
			connection.Read(r.Context())
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "runtime", Value: body, Path: "/"})
		io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	return server
}

func assertBrowserWorkbenchResponse(t *testing.T, address string, status int, body string) {
	t.Helper()
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	response, err := client.Get(address)
	if err != nil {
		t.Fatal("stable browser listener is unavailable", err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != status || body != "" && string(payload) != body {
		t.Fatalf("browser response = %d %q (%v), want %d %q", response.StatusCode, payload, err, status, body)
	}
	if status != http.StatusOK && strings.Contains(string(payload), "workbench-body") {
		t.Fatal("detached browser listener exposed old runtime content")
	}
}

func assertBrowserEndpointOpen(t *testing.T, endpoint *runtimebridge.Endpoint, address string) {
	t.Helper()
	select {
	case <-endpoint.Done():
		t.Fatal("promotion closed the stable browser endpoint")
	default:
	}
	if endpoint.LocalURL() != address {
		t.Fatal("promotion changed the stable browser URL")
	}
}

func TestCandidateWorkbenchBrowserKeepsEntryAcrossReadyRefusalAndReady(t *testing.T) {
	fixture := newBrowserCandidateFixture(t)
	var firstRequests, lastRequests atomic.Int32
	firstRuntime := browserWorkbenchRuntime(t, "first-workbench-body", &firstRequests)
	lastRuntime := browserWorkbenchRuntime(t, "last-workbench-body", &lastRequests)
	first := fixture.promote(t, 1, runtimebridge.Binding{Generation: 7, URL: firstRuntime.URL + "/?token=first-test-runtime"}, "")
	manager, endpoint := fixture.manager, first.endpoint
	address := first.result.URL
	if endpoint == nil || address == "" || endpoint.CurrentMux() != first.mux || connectionState(first).Stage != "ready" {
		t.Fatal("first initiated candidate did not attach the browser workbench")
	}
	assertBrowserWorkbenchResponse(t, address, http.StatusOK, "first-workbench-body")
	beforeRefusal := firstRequests.Load()
	refused := fixture.promote(t, 2, runtimebridge.Binding{}, "p2p.runtime_unavailable")
	state := connectionState(refused)
	if state.Stage != "connected" || state.Error != "p2p.runtime_unavailable" || state.RuntimeGeneration != 0 || refused.result.URL != "" || refused.predecessor != first {
		t.Fatal("refusal did not keep only the exact committed device transport", state)
	}
	assertBrowserEndpointOpen(t, endpoint, address)
	if manager.endpoints[refused.PairID] != endpoint || endpoint.CurrentMux() != nil || endpoint.Detach(first.mux) {
		t.Fatal("refusal did not detach the exact old mux from the retained browser endpoint")
	}
	if !refused.transport.LiveState().Ready || refused.ctx.Err() != nil {
		t.Fatal("explicit workbench refusal ended the live initiated transport")
	}
	if first.ctx.Err() == nil {
		t.Fatal("promotion did not retire the exact predecessor session")
	}
	select {
	case <-refused.mux.Done():
		t.Fatal("explicit workbench refusal closed the committed initiated mux")
	default:
	}
	assertBrowserWorkbenchResponse(t, address, http.StatusBadGateway, "")
	if firstRequests.Load() != beforeRefusal {
		t.Fatal("retained browser listener still reached the previous runtime after refusal")
	}
	if _, err := manager.Entry(refused.PairID, state.Generation); err == nil || err.Error() != "p2p.not_connected" {
		t.Fatal("transport-only refusal exposed a ready browser entry", err)
	}
	latestBinding := runtimebridge.Binding{Generation: 9, URL: lastRuntime.URL + "/?token=last-test-runtime"}
	recovered := fixture.promote(t, 3, latestBinding, "")
	assertBrowserEndpointOpen(t, endpoint, address)
	entry, err := manager.Entry(recovered.PairID, recovered.lease.Generation)
	if err != nil || entry.URL != address || entry.State.Stage != "ready" || entry.State.RuntimeGeneration != 9 || entry.State.Error != "" || recovered.endpoint != endpoint || manager.endpoints[recovered.PairID] != endpoint || endpoint.CurrentMux() != recovered.mux || recovered.predecessor != refused {
		t.Fatalf("later ready candidate did not replace the retained browser attachment: %+v, %v", entry, err)
	}
	if binding, err := endpoint.Binding(); err != nil || binding != latestBinding {
		t.Fatalf("retained browser endpoint binding = %+v, %v; want %+v", binding, err, latestBinding)
	}
	if recovered.stagedEndpoint == nil || recovered.stagedEndpoint == endpoint {
		t.Fatal("replacement did not stage a separate endpoint for its own probe")
	}
	select {
	case <-recovered.stagedEndpoint.Done():
	default:
		t.Fatal("replacement retained its temporary probe endpoint after reusing the stable listener")
	}
	if endpoint.Detach(first.mux) || endpoint.Detach(refused.mux) || endpoint.CurrentMux() != recovered.mux {
		t.Fatal("stale predecessor cleanup detached the newly ready browser mux")
	}
	assertBrowserWorkbenchResponse(t, address, http.StatusOK, "last-workbench-body")
	if firstRequests.Load() != beforeRefusal || lastRequests.Load() < 3 {
		t.Fatal("browser recovery did not use only the newly probed runtime")
	}
	t.Log("initiated ready->explicit refusal->ready preserved one live browser URL, detached the exact predecessor mux, and served the replacement through real Pion HTTP/WS")
}
