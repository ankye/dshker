package peersession

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestCandidateWorkbenchProbeRequiresBindingOrExplicitRefusal(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		requested  bool
		refusal    string
		generation uint64
		gateway    bool
		endpoint   bool
		want       string
	}{
		{name: "transport only"},
		{name: "unrequested binding", generation: 7, gateway: true, endpoint: true, want: "p2p.runtime_invalid"},
		{name: "unrequested generation", generation: 7, want: "p2p.runtime_invalid"},
		{name: "unrequested refusal", refusal: "p2p.runtime_unavailable", want: "p2p.runtime_invalid"},
		{name: "explicit refusal", requested: true, refusal: "p2p.runtime_unavailable"},
		{name: "unexplained absence", requested: true, want: "p2p.runtime_unavailable"},
		{name: "refusal with runtime generation", requested: true, refusal: "p2p.runtime_unavailable", generation: 7, want: "p2p.runtime_unavailable"},
		{name: "incomplete staged resources", requested: true, generation: 7, endpoint: true, want: "p2p.runtime_invalid"},
		{name: "refusal with binding", requested: true, refusal: "p2p.runtime_unavailable", generation: 7, gateway: true, endpoint: true, want: "p2p.runtime_invalid"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			connection := newSession(t.Context())
			defer connection.cancel()
			connection.requestWorkbench, connection.workbenchRefusal = scenario.requested, scenario.refusal
			connection.result.State.RuntimeGeneration = scenario.generation
			if scenario.gateway {
				connection.stagedGateway = &runtimebridge.Gateway{URL: "http://127.0.0.1:1/"}
			}
			if scenario.endpoint {
				connection.stagedEndpoint = &runtimebridge.Endpoint{}
			}
			err := (&Manager{}).probeCandidate(connection)
			if scenario.want == "" && err != nil || scenario.want != "" && (err == nil || err.Error() != scenario.want) {
				t.Fatalf("probe admission = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestCandidateWorkbenchBindingStillRequiresHTTPAndWebSocketProbe(t *testing.T) {
	for _, scenario := range []struct {
		name string
		http bool
		want string
	}{
		{name: "HTTP refused", want: "p2p.runtime_http_failed"},
		{name: "WebSocket refused", http: true, want: "p2p.runtime_websocket_failed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var requests, sockets atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path == "/api/remote.mux" {
					sockets.Add(1)
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				if !scenario.http {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				http.SetCookie(w, &http.Cookie{Name: "probe", Value: "unit-test", Path: "/"})
			}))
			defer server.Close()
			connection := newSession(t.Context())
			defer connection.cancel()
			connection.requestWorkbench = true
			connection.result.State.RuntimeGeneration = 7
			connection.stagedGateway = &runtimebridge.Gateway{URL: server.URL}
			connection.stagedEndpoint = &runtimebridge.Endpoint{}
			if err := (&Manager{}).probeCandidate(connection); err == nil || err.Error() != scenario.want {
				t.Fatalf("provided workbench skipped its required probe: %v", err)
			}
			if requests.Load() == 0 || scenario.http && sockets.Load() != 1 || !scenario.http && sockets.Load() != 0 {
				t.Fatal("probe did not exercise the required HTTP/WebSocket boundary")
			}
		})
	}
}

func TestCandidateWorkbenchRefusalKeepsCommittedTransportAndDetachesOldRuntime(t *testing.T) {
	manager, connection, ticket, _, _, ready := readyInboundOrderFixture(t, true)
	previous := ready.predecessor
	endpoint := manager.inboundEndpoints[connection.PairID]
	if endpoint == nil || endpoint.CurrentMux() != previous.mux {
		t.Fatal("fixture has no exact predecessor attachment")
	}
	connection.workbenchRefusal = "p2p.runtime_unavailable"
	connection.result.State.Error = connection.workbenchRefusal
	if err := manager.promoteCandidate(connection, committedHandoffState(ticket), false); err != nil {
		t.Fatal(err)
	}
	state := connectionState(connection)
	if state.Stage != "connected" || state.RuntimeGeneration != 0 || state.Error != connection.workbenchRefusal || connection.result.URL != "" {
		t.Fatal("transport-only promotion claimed a workbench or lost its refusal", state)
	}
	if manager.inbound[connection.PairID] != connection || !connection.transport.LiveState().Ready || connection.ctx.Err() != nil {
		t.Fatal("explicit workbench refusal ended the committed device transport")
	}
	select {
	case <-connection.mux.Done():
		t.Fatal("explicit workbench refusal closed the committed mux")
	default:
	}
	if endpoint.CurrentMux() != nil {
		t.Fatal("promotion kept stale answered runtime forwarding")
	}
	// An answered ServeTarget belongs to its retired runtime; stable browser
	// listeners are initiated-direction resources covered separately.
	select {
	case <-endpoint.Done():
	default:
		t.Fatal("promotion retained the retired answered runtime endpoint")
	}
	connection.mu.Lock()
	connection.result.State.Stage, connection.result.State.Error = "suspended", ""
	connection.mu.Unlock()
	manager.transportChanged(connection)
	if restored := connectionState(connection); restored.Stage != "connected" || restored.Error != "p2p.runtime_unavailable" || restored.RuntimeGeneration != 0 {
		t.Fatal("transport recovery lost the original workbench refusal", restored)
	}
}

func TestCandidateWorkbenchRefusalSurvivesCommittedEventBeforeReadyReply(t *testing.T) {
	manager, connection, ticket, _, active, ready := readyInboundOrderFixture(t, false)
	connection.workbenchRefusal = "p2p.protocol_mismatch"
	connection.result.State.Error = connection.workbenchRefusal
	result := make(chan error, 1)
	go func() { result <- manager.readyCandidate(connection) }()
	select {
	case <-ready.entered:
	case <-manager.ctx.Done():
		t.Fatal("Ready did not enter its controlled in-flight window")
	}
	state := committedHandoffState(ticket)
	manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate-decision", State: state})
	if actual := connectionState(connection); actual.Stage != "connected" || actual.Error != connection.workbenchRefusal || !manager.isPromoted(connection) {
		t.Fatal("early committed event discarded the exact workbench refusal", actual)
	}
	ready.unblock()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if actual := connectionState(connection); actual.Stage != "connected" || actual.Error != connection.workbenchRefusal || !connection.transport.LiveState().Ready {
		t.Fatal("late Ready reply changed transport-only promotion", actual)
	}
}
