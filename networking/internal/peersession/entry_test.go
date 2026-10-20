package peersession

import (
	"context"
	"testing"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// An inert authenticated-link double is sufficient for attachment/readback
// admission. Real transport, DSH HTTP and WS recovery are integration-owned.
type entryLink struct {
	messages chan []byte
	done     chan struct{}
}

func (link entryLink) Send([]byte) error       { return nil }
func (link entryLink) Messages() <-chan []byte { return link.messages }
func (link entryLink) Done() <-chan struct{}   { return link.done }

func readyEntryManager(t *testing.T) (*Manager, *session) {
	t.Helper()
	manager, pin := pinFixture()
	manager.ctx, manager.cancel = context.WithCancel(context.Background())
	t.Cleanup(manager.cancel)
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	connection := newSession(manager.ctx)
	connection.PairID = pin.Pair.PairID
	connection.lease = protocol.Lease{AttemptID: "111111111111", Generation: 3, FromDeviceID: manager.config.Device.DeviceID}
	link := entryLink{make(chan []byte), make(chan struct{})}
	mux, err := peer.NewMux(link, peer.StreamScope{AttemptID: connection.lease.AttemptID, Generation: 3, RuntimeGeneration: 7, Initiator: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mux.Close() })
	manager.sessions = map[string]*session{connection.PairID: connection}
	_, endpoint, err := runtimebridge.Attach(manager.ctx, mux, runtimebridge.Binding{Generation: 7, URL: "http://127.0.0.1:1/?token=focused-entry-test"}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(endpoint.Close)
	connection.mux, connection.endpoint = mux, endpoint
	manager.endpoints = map[string]*runtimebridge.Endpoint{connection.PairID: endpoint}
	connection.result = Connected{State: State{PairID: connection.PairID, AttemptID: connection.lease.AttemptID, Generation: 3, RuntimeGeneration: 7, Stage: "ready"}, URL: endpoint.LocalURL()}
	return manager, connection
}

func TestEntryReadsOnlyCurrentReadyAttachment(t *testing.T) {
	manager, connection := readyEntryManager(t)
	manager.owner = func(context.Context, string) (runtimebridge.Binding, error) {
		t.Fatal("readback invoked the runtime owner")
		return runtimebridge.Binding{}, nil
	}
	for count := 0; count < 2; count++ {
		entry, err := manager.Entry(connection.PairID, 3)
		if err != nil || entry != connection.result {
			t.Fatalf("Entry = %+v, %v", entry, err)
		}
	}
	if connection.endpoint.CurrentMux() != connection.mux {
		t.Fatal("readback changed the attachment")
	}
}

func TestEntryRejectsInvalidStaleAndUnavailableOwners(t *testing.T) {
	for _, scenario := range []string{"invalid", "stale-generation", "stale-attempt", "non-ready", "revoked", "closed", "missing", "detached", "mux-closed", "binding-generation"} {
		t.Run(scenario, func(t *testing.T) {
			manager, connection := readyEntryManager(t)
			pairID, generation, want := connection.PairID, uint64(3), "p2p.stale_generation"
			switch scenario {
			case "invalid":
				pairID, want = "bad", "p2p.invalid_request"
			case "stale-generation":
				generation = 2
			case "stale-attempt":
				connection.result.State.AttemptID = "222222222222"
			case "non-ready":
				connection.result.State.Stage, want = "connected", "p2p.not_connected"
			case "revoked":
				delete(manager.pins, pairID)
				want = "p2p.pair_unauthorized"
			case "closed":
				manager.closed, want = true, "p2p.helper_unavailable"
			case "missing":
				delete(manager.sessions, pairID)
				want = "p2p.connection_not_found"
			case "detached":
				connection.endpoint.Detach(connection.mux)
			case "mux-closed":
				connection.mux.Close()
				want = "p2p.not_connected"
			case "binding-generation":
				connection.result.State.RuntimeGeneration++
			}
			if _, err := manager.Entry(pairID, generation); err == nil || err.Error() != want {
				t.Fatalf("Entry = %v, want %s", err, want)
			}
		})
	}
}

func TestStaleEstablishmentAndCleanupCannotDetachCurrentEntry(t *testing.T) {
	manager, current := readyEntryManager(t)
	old := newSession(manager.ctx)
	old.PairID, old.lease = current.PairID, current.lease
	old.lease.Generation = 2
	if _, _, err := manager.stageCandidate(old, nil, runtimebridge.Binding{}, true); err == nil || err.Error() != "p2p.stale_generation" {
		t.Fatalf("stale establishment = %v", err)
	}
	manager.finish(old.PairID, old)
	if _, err := manager.Entry(current.PairID, 3); err != nil {
		t.Fatalf("stale attempt affected replacement: %v", err)
	}
	manager.inbound = map[string]*session{current.PairID: newSession(manager.ctx)}
	delete(manager.sessions, current.PairID)
	if err := manager.Disconnect(current.PairID); err == nil || err.Error() != "p2p.not_connected" {
		t.Fatalf("outbound disconnect = %v", err)
	}
	if manager.inbound[current.PairID].ctx.Err() != nil {
		t.Fatal("outbound disconnect cancelled the independent answered session")
	}
}

func TestDisconnectWaitingForOldSessionCannotDetachNewAttachment(t *testing.T) {
	manager, old := readyEntryManager(t)
	oldURL := old.endpoint.LocalURL()
	disconnected := make(chan error, 1)
	go func() { disconnected <- manager.Disconnect(old.PairID) }()
	// Disconnect has committed its detach and selected the old session. Keep
	// its completion blocked while a replacement installs at the same gateway.
	<-old.ctx.Done()
	current := newSession(manager.ctx)
	current.PairID = old.PairID
	current.lease = old.lease
	current.lease.AttemptID, current.lease.Generation = "333333333333", 4
	link := entryLink{make(chan []byte), make(chan struct{})}
	mux, err := peer.NewMux(link, peer.StreamScope{AttemptID: current.lease.AttemptID, Generation: 4, RuntimeGeneration: 7, Initiator: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mux.Close() })
	_, endpoint, err := runtimebridge.Attach(manager.ctx, mux, runtimebridge.Binding{Generation: 7, URL: "http://127.0.0.1:1/?token=focused-entry-test"}, true, old.endpoint)
	if err != nil {
		t.Fatal(err)
	}
	current.result = Connected{State: State{PairID: current.PairID, AttemptID: current.lease.AttemptID, Generation: 4, RuntimeGeneration: 7, Stage: "ready"}, URL: endpoint.LocalURL()}
	current.mux, current.endpoint = mux, endpoint
	manager.mu.Lock()
	manager.sessions[current.PairID] = current
	manager.mu.Unlock()
	manager.finish(old.PairID, old)
	if err := <-disconnected; err != nil {
		t.Fatal(err)
	}
	entry, err := manager.Entry(current.PairID, 4)
	if err != nil || entry.URL != oldURL || endpoint.CurrentMux() != mux {
		t.Fatalf("late disconnect detached replacement or changed gateway: %v", err)
	}
	manager.finish(current.PairID, current)
}

func TestPromotedMuxTerminationPublishesDisconnectedAndWakes(t *testing.T) {
	manager, connection := readyEntryManager(t)
	connection.ticket = &protocol.CandidateTicket{}
	connection.promoted = true
	var emitted State
	manager.emit = func(state State) {
		emitted = state
		current, err := manager.CurrentState(connection.PairID)
		if err != nil || current.Stage != "disconnected" || !manager.OwnsState(state) {
			t.Fatal("terminal publication did not match its owner truth", current, err)
		}
	}
	wakes := 0
	manager.config.Wake = func(pairID string) {
		if pairID == connection.PairID {
			wakes++
		}
	}
	connection.mux.Close()
	connection.noteStop("mux_done", connection.mux.Err())
	manager.cleanupCandidate(connection, connectionState(connection))
	if emitted.Stage != "disconnected" || emitted.AttemptID != connection.lease.AttemptID || emitted.RuntimeGeneration != 7 || wakes != 1 {
		t.Fatal("mux termination left ready projection or did not wake reconciliation", emitted, wakes)
	}
	if state, err := manager.CurrentState(connection.PairID); err == nil || state.Stage == "ready" {
		t.Fatal("retired mux remained eligible as ready", state, err)
	}
}
