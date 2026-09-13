package peersession

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// A gateway is what a URL points at, so its lifetime decides whether that URL
// stays usable. It must belong to the pair, not to one session: a browser tab
// left open has to keep working after a reconnect, which it cannot do if the
// loopback port is reallocated every time the direct path is rebuilt.
func TestEndpointOutlivesItsSession(t *testing.T) {
	manager, pin := pinFixture()
	manager.ctx, manager.cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer manager.cancel()
	manager.sessions = make(map[string]*session)
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}

	// Stand in for what Establish stores on a pair's first connection.
	endpoint := &runtimebridge.Endpoint{}
	manager.mu.Lock()
	manager.endpoints[pin.Pair.PairID] = endpoint
	manager.mu.Unlock()

	// A session ending — a drop, or an explicit Disconnect — leaves the pair
	// pinned, so the endpoint has to survive for the next attempt to reuse.
	connection := newSession(manager.ctx)
	connection.PairID = pin.Pair.PairID
	manager.mu.Lock()
	manager.sessions[pin.Pair.PairID] = connection
	manager.mu.Unlock()
	manager.finish(pin.Pair.PairID, connection)

	manager.mu.Lock()
	kept := manager.endpoints[pin.Pair.PairID]
	manager.mu.Unlock()
	if kept != endpoint {
		t.Fatal("a session ending discarded the pair's endpoint, so its URL would change on reconnect")
	}
	select {
	case <-endpoint.Done():
		t.Fatal("a session ending closed the pair's gateway")
	default:
	}
}

// Losing authorization is the one thing that must end the gateway: a revoked
// pair has to stop being reachable at once rather than when whatever session
// was using it happens to end.
func TestRevocationClosesTheEndpoint(t *testing.T) {
	manager, pin := pinFixture()
	manager.ctx, manager.cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer manager.cancel()
	manager.sessions = make(map[string]*session)
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	endpoint := &runtimebridge.Endpoint{}
	manager.mu.Lock()
	manager.endpoints[pin.Pair.PairID] = endpoint
	manager.mu.Unlock()

	manager.revoke(pin.Pair.PairID)

	manager.mu.Lock()
	remaining, pinned := manager.endpoints[pin.Pair.PairID], manager.pins[pin.Pair.PairID]
	manager.mu.Unlock()
	if remaining != nil {
		t.Fatal("a revoked pair kept its endpoint")
	}
	if pinned.Pair.PairID != "" {
		t.Fatal("a revoked pair stayed pinned")
	}
	select {
	case <-endpoint.Done():
	case <-time.After(time.Second):
		t.Fatal("a revoked pair's gateway stayed open")
	}
}
