package peer

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A disconnected ICE connection is a hiccup, not a loss: WiFi changes and
// machines waking up report it and recover within seconds. Failing the
// transport on the event is what made a brief interruption cost a full
// re-punch, so recovery inside the window must leave the transport intact.
func TestGracePeriodRecoveryKeepsTransport(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()

	transport.beginGrace()
	transport.endGrace()

	select {
	case <-transport.ctx.Done():
		t.Fatal("recovered connection was still declared lost")
	case <-time.After(50 * time.Millisecond):
	}
	transport.mu.Lock()
	timer := transport.graceTimer
	transport.mu.Unlock()
	if timer != nil {
		t.Fatal("recovery left the window armed")
	}
}

// Repeated disconnected events must not keep extending the window: the peer
// would then never be reported gone.
func TestGracePeriodDoesNotRestartOnRepeatedEvents(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()

	transport.beginGrace()
	transport.mu.Lock()
	first := transport.graceTimer
	transport.mu.Unlock()
	transport.beginGrace()
	transport.mu.Lock()
	second := transport.graceTimer
	transport.mu.Unlock()
	if first != second {
		t.Fatal("a second disconnected event replaced the window")
	}
}

// A connection that never comes back has to end, so the window's expiry is
// what declares the direct path lost.
func TestGracePeriodExpiryFailsTransport(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()

	transport.mu.Lock()
	transport.graceTimer = time.AfterFunc(10*time.Millisecond, func() {
		transport.fail(errors.New("p2p.direct_unavailable"))
	})
	transport.mu.Unlock()

	select {
	case <-transport.ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("an unrecovered connection was never declared lost")
	}
}

// Closing must drop the window so a closed transport is not failed later by a
// timer that outlived it.
func TestCloseDropsGraceWindow(t *testing.T) {
	transport := newGraceTestTransport()
	transport.beginGrace()
	close(transport.closed)
	if err := transport.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	transport.mu.Lock()
	timer := transport.graceTimer
	transport.mu.Unlock()
	if timer != nil {
		t.Fatal("close left the window armed")
	}
}

// newGraceTestTransport builds the minimum transport the recovery window needs:
// no peer connection is required to exercise the window itself.
func newGraceTestTransport() *Transport {
	ctx, cancel := context.WithCancel(context.Background())
	return &Transport{
		ctx:      ctx,
		cancel:   cancel,
		closed:   make(chan struct{}),
		ready:    make(chan struct{}),
		messages: make(chan []byte, 1),
		errors:   make(chan error, 1),
	}
}
