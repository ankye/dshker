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

// The callback has begun but cannot commit while recovery owns the same lock.
// Invoking the real expiry commit seam avoids waiting for, or racing, 20 seconds.
func TestGraceStartedExpiryCannotCancelRecoveredTransport(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()
	transport.beginGrace()
	transport.mu.Lock()
	window := transport.graceWindow
	started, finished := make(chan struct{}), make(chan struct{})
	go func() {
		close(started)
		transport.expireGrace(window)
		close(finished)
	}()
	<-started
	transport.endGraceLocked()
	transport.mu.Unlock()
	<-finished
	select {
	case <-transport.ctx.Done():
		t.Fatal("an already-started stale grace callback canceled the recovered transport")
	default:
	}
}

func TestGraceOldExpiryCannotCancelNewWindow(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()
	defer transport.endGrace()
	transport.beginGrace()
	old := transport.graceWindow
	transport.endGrace()
	transport.beginGrace()
	current := transport.graceWindow
	transport.expireGrace(old)
	select {
	case <-transport.ctx.Done():
		t.Fatal("the previous grace callback canceled a later disconnect window")
	default:
	}
	transport.expireGrace(current)
	select {
	case <-transport.ctx.Done():
	default:
		t.Fatal("a still-owned grace window did not terminate the unrecovered transport")
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

// A peer whose process was killed ends the connection explicitly: DTLS sends
// CloseNotify and the peer connection reports closed. That must stay
// immediate — the recovery window is only for a disconnect that carries no
// such signal — or the user keeps driving a tab that cannot answer.
func TestExplicitCloseIsNotGivenAGraceWindow(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()

	transport.fail(errors.New("p2p.direct_unavailable"))

	select {
	case <-transport.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("an explicit close waited for the recovery window")
	}
	transport.mu.Lock()
	timer := transport.graceTimer
	transport.mu.Unlock()
	if timer != nil {
		t.Fatal("an explicit close armed the recovery window")
	}
}
