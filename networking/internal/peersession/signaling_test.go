package peersession

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// fakeSubscription stands in for the coordinator connection. It can be lost on
// demand, which is the whole point: the failure that used to leave P2P dead
// until an application restart is exactly "the subscription ended".
type fakeSubscription struct {
	events chan controlplane.SignalEvent
	done   chan struct{}
	sent   chan protocol.Signal
	once   sync.Once
}

func newFakeSubscription() *fakeSubscription {
	return &fakeSubscription{
		events: make(chan controlplane.SignalEvent, 4),
		done:   make(chan struct{}),
		sent:   make(chan protocol.Signal, 4),
	}
}

func (fake *fakeSubscription) Events() <-chan controlplane.SignalEvent { return fake.events }
func (fake *fakeSubscription) Done() <-chan struct{}                   { return fake.done }
func (fake *fakeSubscription) Send(_ context.Context, signal protocol.Signal) error {
	fake.sent <- signal
	return nil
}
func (fake *fakeSubscription) Close() { fake.once.Do(func() { close(fake.done) }) }

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A lost control-plane connection must be replaced in-process. Before this,
// the manager kept the dead subscription: attempts and signals stopped
// arriving, nothing reconnected, and only restarting the application brought
// P2P back.
func TestSignalingReplacesALostSubscription(t *testing.T) {
	first, second := newFakeSubscription(), newFakeSubscription()
	var mu sync.Mutex
	dialed := 0
	installed := make(chan subscription, 4)
	dial := func(context.Context, string) (subscription, error) {
		mu.Lock()
		defer mu.Unlock()
		dialed++
		switch dialed {
		case 1:
			return first, nil
		case 2:
			// One failed dial proves the retry loop outlives a coordinator that
			// is not back yet instead of giving up on the first refusal.
			return nil, errors.New("p2p.server_unavailable")
		default:
			return second, nil
		}
	}

	owner, err := newSignaling(context.Background(), dial, "device", func(active subscription) {
		installed <- active
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.close)

	select {
	case got := <-installed:
		if got != first {
			t.Fatal("first subscription was not handed to receive")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("receive was never started for the first subscription")
	}

	first.Close()
	waitFor(t, "signalling to be marked down", owner.isDown)
	if _, ok := owner.current(); ok {
		t.Fatal("a lost subscription is still reported as usable")
	}
	// While down, a connect attempt must fail immediately with the signalling
	// code rather than wait out its deadline and blame the transport.
	err = owner.send(context.Background(), protocol.Signal{Version: 1, Type: "offer"})
	if err == nil || err.Error() != "p2p.server_unavailable" {
		t.Fatalf("send while down = %v, want p2p.server_unavailable", err)
	}

	waitFor(t, "the replacement subscription", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return dialed >= 3
	})
	waitFor(t, "signalling to recover", func() bool { return !owner.isDown() })
	select {
	case got := <-installed:
		if got != second {
			t.Fatal("receive was not restarted on the replacement subscription")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("receive was never started for the replacement subscription")
	}

	if err = owner.send(context.Background(), protocol.Signal{Version: 1, Type: "offer"}); err != nil {
		t.Fatalf("send after recovery: %v", err)
	}
	select {
	case <-second.sent:
	case <-time.After(2 * time.Second):
		t.Fatal("a recovered send did not reach the replacement subscription")
	}
	select {
	case <-first.sent:
		t.Fatal("a recovered send reused the lost subscription")
	default:
	}

	owner.close()
	mu.Lock()
	afterClose := dialed
	mu.Unlock()
	time.Sleep(1200 * time.Millisecond)
	mu.Lock()
	settled := dialed
	mu.Unlock()
	if settled != afterClose {
		t.Fatalf("a closed supervisor kept dialling: %d -> %d", afterClose, settled)
	}
}
