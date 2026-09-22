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

	mu         sync.Mutex
	superseded bool
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
func (fake *fakeSubscription) Close() {
	fake.once.Do(func() {
		close(fake.done)
		close(fake.events)
	})
}

func (fake *fakeSubscription) Superseded() bool {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.superseded
}

// displace ends this subscription the way the coordinator ends a socket that a
// newer one for the same device replaced.
func (fake *fakeSubscription) displace() {
	fake.mu.Lock()
	fake.superseded = true
	fake.mu.Unlock()
	fake.Close()
}

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

// A displaced subscription must not be replaced, or the two sockets kick each
// other off forever.
//
// One device holds exactly one signalling socket: the id is derived from its
// public key and the socket is authenticated by mTLS, so a second connection is
// always the same machine and the newest one is the live one. The coordinator
// therefore closes the older socket instead of refusing the new one — refusing it
// locked a device out of signalling entirely, because there is no ping/pong or
// read deadline on that socket and a half-open connection is never detected.
//
// The displacement has to stop the loser's supervisor. It reconnects one second
// after any loss, and a reconnect displaces the live socket, whose supervisor
// reconnects a second later and displaces this one — an endless kick-loop that
// leaves neither side usable. The supervisor stays marked down instead, so an
// attempt fails immediately with a truthful code.
func TestSignalingStandsDownWhenSuperseded(t *testing.T) {
	first := newFakeSubscription()
	var mu sync.Mutex
	dialed := 0
	dial := func(context.Context, string) (subscription, error) {
		mu.Lock()
		defer mu.Unlock()
		dialed++
		if dialed == 1 {
			return first, nil
		}
		// Any dial after the displacement is the kick-loop this guards against.
		return newFakeSubscription(), nil
	}
	owner, err := newSignaling(context.Background(), dial, "device", func(subscription) {})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.close()

	first.displace()

	waitFor(t, "signalling to be marked down", owner.isDown)
	// Well past the one-second retry floor: a supervisor that was going to
	// re-subscribe would have done so several times over by now.
	time.Sleep(3 * time.Second)
	mu.Lock()
	settled := dialed
	mu.Unlock()
	if settled != 1 {
		t.Fatalf("a displaced subscription was replaced %d times; that is the kick-loop", settled-1)
	}
	if !owner.isDown() {
		t.Fatal("a displaced supervisor reported signalling as healthy")
	}
}

// A socket can finish between the first dial and supervise starting. That is
// still a loss to repair, not a reason for the supervisor to exit silently.
func TestSignalingRepairsSubscriptionClosedBeforeSupervisorStarts(t *testing.T) {
	first, second := newFakeSubscription(), newFakeSubscription()
	first.Close()
	var mu sync.Mutex
	dials := 0
	owner, err := newSignaling(context.Background(), func(context.Context, string) (subscription, error) {
		mu.Lock()
		defer mu.Unlock()
		dials++
		if dials == 1 {
			return first, nil
		}
		return second, nil
	}, "device", func(subscription) {})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.close()

	waitFor(t, "replacement of an immediately closed subscription", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return dials == 2 && !owner.isDown()
	})
}

// Reconnect is invoked by an RPC whose context ends after the reply. The
// subscription's read loop and heartbeat must remain attached to the manager.
func TestReconnectSignalsOutlivesRequestContext(t *testing.T) {
	managerCtx, stopManager := context.WithCancel(context.Background())
	defer stopManager()
	first, second := newFakeSubscription(), newFakeSubscription()
	var mu sync.Mutex
	dials := 0
	dial := func(ctx context.Context, _ string) (subscription, error) {
		mu.Lock()
		dials++
		index := dials
		mu.Unlock()
		active := first
		if index == 2 {
			active = second
		}
		go func() {
			<-ctx.Done()
			active.Close()
		}()
		return active, nil
	}
	manager := &Manager{ctx: managerCtx, cancel: stopManager, config: Config{Device: controlplane.Device{DeviceID: "device"}}, subscribe: dial}
	var err error
	manager.signals, err = newSignaling(managerCtx, dial, "device", manager.receive)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { manager.signals.close() }()
	first.displace()
	waitFor(t, "displaced subscription to go down", manager.signals.isDown)

	requestCtx, finishRequest := context.WithCancel(context.Background())
	if err := manager.ReconnectSignals(requestCtx); err != nil {
		t.Fatal(err)
	}
	finishRequest()
	select {
	case <-second.Done():
		t.Fatal("request cancellation closed the manager-owned subscription")
	case <-time.After(50 * time.Millisecond):
	}
	if err := manager.signals.send(context.Background(), protocol.Signal{Version: 1, Type: "offer"}); err != nil {
		t.Fatalf("send after RPC ended: %v", err)
	}
	mu.Lock()
	gotDials := dials
	mu.Unlock()
	if gotDials != 2 {
		t.Fatalf("subscription dials = %d, want 2", gotDials)
	}
}

// Two reconciliation calls for the same failed socket must install exactly one
// replacement, or their sockets displace each other on the coordinator.
func TestReconnectSignalsSerializesConcurrentRepairs(t *testing.T) {
	managerCtx, stopManager := context.WithCancel(context.Background())
	defer stopManager()
	first, second := newFakeSubscription(), newFakeSubscription()
	entered, release := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	dials := 0
	dial := func(context.Context, string) (subscription, error) {
		mu.Lock()
		dials++
		index := dials
		mu.Unlock()
		if index == 1 {
			return first, nil
		}
		if index == 2 {
			close(entered)
			<-release
			return second, nil
		}
		return nil, errors.New("unexpected extra subscription")
	}
	manager := &Manager{ctx: managerCtx, cancel: stopManager, config: Config{Device: controlplane.Device{DeviceID: "device"}}, subscribe: dial}
	var err error
	manager.signals, err = newSignaling(managerCtx, dial, "device", manager.receive)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { manager.signals.close() }()
	first.displace()
	waitFor(t, "displaced subscription to go down", manager.signals.isDown)

	results := make(chan error, 2)
	go func() { results <- manager.ReconnectSignals(context.Background()) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first repair never dialed")
	}
	go func() { results <- manager.ReconnectSignals(context.Background()) }()
	close(release)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	gotDials := dials
	mu.Unlock()
	if gotDials != 2 || manager.signals.isDown() {
		t.Fatalf("repairs left %d dials and down=%v; want one live replacement", gotDials, manager.signals.isDown())
	}
}

// A manager holding no subscription at all is repairable, not healthy. The first
// dial can fail while the manager is being created, and the supervisor that would
// retry is only started by a dial that succeeded — so an absent subscription used
// to be permanent: ReconnectSignals returned nil without doing anything and every
// connect answered p2p.server_unavailable for the life of the process.
func TestReconnectSignalsSubscribesWhenNoneIsHeld(t *testing.T) {
	managerCtx, stopManager := context.WithCancel(context.Background())
	defer stopManager()
	established := newFakeSubscription()
	var mu sync.Mutex
	dials := 0
	dial := func(context.Context, string) (subscription, error) {
		mu.Lock()
		defer mu.Unlock()
		dials++
		return established, nil
	}
	// signals is deliberately nil: the state a manager is left in when its very
	// first subscription attempt failed.
	manager := &Manager{ctx: managerCtx, cancel: stopManager, config: Config{Device: controlplane.Device{DeviceID: "device"}}, subscribe: dial}

	if err := manager.ReconnectSignals(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	gotDials := dials
	mu.Unlock()
	if gotDials != 1 {
		t.Fatalf("subscription dials = %d, want 1; an absent subscription was treated as healthy", gotDials)
	}
	if manager.signals == nil || manager.signals.isDown() {
		t.Fatal("repair left the manager without usable signalling")
	}
	defer func() { manager.signals.close() }()
	if err := manager.signals.send(context.Background(), protocol.Signal{Version: 1, Type: "offer"}); err != nil {
		t.Fatalf("send after repairing absent signalling: %v", err)
	}
}

// The end-to-end shape of the reported failure: a displaced socket makes send
// refuse with p2p.server_unavailable, and the repair an explicit connect now
// performs has to make that same send work again without restarting anything.
func TestReconnectSignalsRestoresSendAfterDisplacement(t *testing.T) {
	managerCtx, stopManager := context.WithCancel(context.Background())
	defer stopManager()
	first, second := newFakeSubscription(), newFakeSubscription()
	var mu sync.Mutex
	dials := 0
	dial := func(context.Context, string) (subscription, error) {
		mu.Lock()
		defer mu.Unlock()
		dials++
		if dials == 1 {
			return first, nil
		}
		return second, nil
	}
	manager := &Manager{ctx: managerCtx, cancel: stopManager, config: Config{Device: controlplane.Device{DeviceID: "device"}}, subscribe: dial}
	var err error
	manager.signals, err = newSignaling(managerCtx, dial, "device", manager.receive)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { manager.signals.close() }()

	first.displace()
	waitFor(t, "displaced subscription to go down", manager.signals.isDown)
	// This is what the user saw: the connect path refused before it ever dialed.
	if err := manager.signals.send(context.Background(), protocol.Signal{Version: 1, Type: "offer"}); err == nil {
		t.Fatal("a displaced subscription accepted a send")
	} else if err.Error() != "p2p.server_unavailable" {
		t.Fatalf("displaced send error = %v, want p2p.server_unavailable", err)
	}

	if err := manager.ReconnectSignals(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := manager.signals.send(context.Background(), protocol.Signal{Version: 1, Type: "offer"}); err != nil {
		t.Fatalf("send after repair: %v", err)
	}
	select {
	case <-second.sent:
	case <-time.After(time.Second):
		t.Fatal("the repaired subscription never carried the signal")
	}
}
