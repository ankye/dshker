package peersession

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// Observe the real Connect admission before the coordinator refuses the attempt.
// A temporary coordinator refusal must not forget an explicitly requested workbench.
func intentManager(t *testing.T) (*Manager, string, func() []bool) {
	t.Helper()
	var manager *Manager
	var gate sync.Mutex
	var requests []bool
	manager = turnCredentialManager(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v2/links/state" {
			http.NotFound(writer, request)
			return
		}
		manager.mu.Lock()
		for _, connection := range manager.candidates {
			gate.Lock()
			requests = append(requests, connection.requestWorkbench)
			gate.Unlock()
		}
		manager.mu.Unlock()
		writer.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(writer).Encode(map[string]string{"code": "p2p.peer_offline"})
	}))
	manager.ctx, manager.cancel = context.WithCancel(context.Background())
	manager.emit = func(State) {}
	manager.sessions = make(map[string]*session)
	manager.config.CoreInstanceID = protocol.NewNonce()
	active := candidateSubscriptionFor(manager.config.CoreInstanceID)
	manager.signals = &signaling{active: active, ctx: manager.ctx, cancel: func() {}}
	t.Cleanup(active.Close)
	t.Cleanup(manager.Close)
	_, pin := pinFixture()
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	return manager, pin.Pair.PairID, func() []bool {
		gate.Lock()
		defer gate.Unlock()
		return append([]bool(nil), requests...)
	}
}

func refusedConnect(t *testing.T, manager *Manager, pairID string, generation uint64, workbench bool) {
	t.Helper()
	if _, err := manager.Connect(context.Background(), pairID, generation, workbench); err == nil || err.Error() != "p2p.peer_offline" {
		t.Fatalf("Connect = %v, want the temporary coordinator refusal", err)
	}
}

func TestExplicitWorkbenchIntentSurvivesFailedAttempt(t *testing.T) {
	manager, pairID, requests := intentManager(t)
	refusedConnect(t, manager, pairID, 1, true)
	refusedConnect(t, manager, pairID, 2, false)
	got := requests()
	if len(got) != 2 || !got[0] || !got[1] {
		t.Fatalf("workbench requests = %v, want explicit intent retained by automatic recovery", got)
	}
}

func TestExplicitDisconnectClearsWorkbenchIntentAfterFailure(t *testing.T) {
	manager, pairID, requests := intentManager(t)
	refusedConnect(t, manager, pairID, 1, true)
	if err := manager.Disconnect(pairID); err == nil || err.Error() != "p2p.not_connected" {
		t.Fatalf("Disconnect after failed attempt = %v", err)
	}
	refusedConnect(t, manager, pairID, 2, false)
	got := requests()
	if len(got) != 2 || !got[0] || got[1] {
		t.Fatalf("workbench requests after explicit disconnect = %v", got)
	}
}

func TestUnadmittedRequestDoesNotCreateWorkbenchIntent(t *testing.T) {
	manager, pairID, requests := intentManager(t)
	manager.mu.Lock()
	pin := manager.pins[pairID]
	delete(manager.pins, pairID)
	manager.mu.Unlock()
	if _, err := manager.Connect(context.Background(), pairID, 1, true); err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatalf("unadmitted Connect = %v", err)
	}
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	refusedConnect(t, manager, pairID, 2, false)
	got := requests()
	if len(got) != 1 || got[0] {
		t.Fatalf("unadmitted request established workbench intent: %v", got)
	}
}
