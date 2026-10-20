package autoconnect

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestReauthorizeClearsOnlyExactDurableIntentAndPreservesOrdinaryWakeRefusals(t *testing.T) {
	test := newHarness()
	first, other := Intent{"service-a", "computer"}, Intent{"service-b", "computer"}
	neighbor := Intent{first.ServiceID, "another-computer"}
	test.fail[first.key()], test.fail[other.key()] = "p2p.pair_revoked", "p2p.pair_unauthorized"
	test.fail[neighbor.key()] = "p2p.network_revoked"
	engine := test.engine([]Intent{first, other, neighbor})
	defer engine.Close()
	engine.Reconcile(context.Background())
	engine.Wake(first)
	engine.Reconcile(context.Background())
	engine.RetryNow(context.Background())
	if test.attemptCount() != 3 {
		t.Fatal("ordinary lifecycle wake cleared a terminal refusal")
	}
	test.mu.Lock()
	delete(test.fail, first.key())
	test.mu.Unlock()
	engine.Reauthorize(first)
	waitFor(t, func() bool { return test.attemptCount() == 4 })
	if _, blocked := engine.Refusal(first.ServiceID, first.PairID); blocked {
		t.Fatal("fresh exact authorization retained its old terminal")
	}
	if code, blocked := engine.Refusal(other.ServiceID, other.PairID); !blocked || code != "p2p.pair_unauthorized" {
		t.Fatal("one fresh authorization cleared another intent's terminal", code)
	}
	if code, blocked := engine.Refusal(neighbor.ServiceID, neighbor.PairID); !blocked || code != "p2p.network_revoked" {
		t.Fatal("one fresh authorization cleared another pair's terminal", code)
	}
	engine.mu.Lock()
	firstEpoch, otherEpoch, neighborEpoch := engine.epochs[first.key()], engine.epochs[other.key()], engine.epochs[neighbor.key()]
	engine.mu.Unlock()
	if firstEpoch != 1 || otherEpoch != 0 || neighborEpoch != 0 {
		t.Fatal("reauthorization advanced another scope's epoch", firstEpoch, otherEpoch, neighborEpoch)
	}
}

func TestReauthorizeFencesOldInflightRefusalAndKeepsOneConnectOwner(t *testing.T) {
	for _, oldRefusal := range []string{"p2p.pair_revoked", "p2p.peer_offline"} {
		t.Run(oldRefusal, func(t *testing.T) {
			reauthorizeInflight(t, oldRefusal)
		})
	}
}

func reauthorizeInflight(t *testing.T, oldRefusal string) {
	t.Helper()
	intent, other := Intent{"service-a", "computer"}, Intent{"service-b", "computer"}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls, otherCalls, simultaneous, maximum, delays atomic.Int32
	var connected atomic.Bool
	engine := New(Options{
		Intents: func(context.Context) ([]Intent, error) { return []Intent{intent, other}, nil },
		Stage: func(serviceID, _ string) ConnectionState {
			if serviceID == intent.ServiceID && connected.Load() {
				return ConnectionState{Stage: "connected"}
			}
			return ConnectionState{}
		},
		Connect: func(_ context.Context, serviceID, _ string) error {
			if serviceID == other.ServiceID {
				otherCalls.Add(1)
				return errors.New("p2p.network_revoked")
			}
			n := simultaneous.Add(1)
			defer simultaneous.Add(-1)
			for previous := maximum.Load(); n > previous && !maximum.CompareAndSwap(previous, n); previous = maximum.Load() {
			}
			if calls.Add(1) == 1 {
				close(entered)
				<-release
				return errors.New(oldRefusal)
			}
			connected.Store(true)
			return nil
		},
		CodeOf: func(err error) string { return err.Error() },
		After: func(time.Duration) <-chan time.Time {
			delays.Add(1)
			return make(chan time.Time)
		},
	})
	defer engine.Close()
	engine.ensure(other)
	engine.Wake(intent)
	<-entered
	engine.Reauthorize(intent)
	if calls.Load() != 1 {
		t.Fatal("reauthorization ran concurrently with the old scope")
	}
	close(release)
	waitFor(t, func() bool {
		engine.mu.Lock()
		_, running := engine.inFlight[intent.key()]
		engine.mu.Unlock()
		return connected.Load() && !running
	})
	if code, blocked := engine.Refusal(intent.ServiceID, intent.PairID); blocked || maximum.Load() != 1 {
		t.Fatal("late old-scope refusal poisoned the new epoch or broke single-flight", code, maximum.Load())
	}
	if code, blocked := engine.Refusal(other.ServiceID, other.PairID); !blocked || code != "p2p.network_revoked" || otherCalls.Load() != 1 || delays.Load() != 0 {
		t.Fatal("old result republished backoff or changed another service's terminal", code, otherCalls.Load(), delays.Load())
	}
	connected.Store(false)
	engine.Wake(intent)
	waitFor(t, func() bool { return calls.Load() == 3 && connected.Load() })
}
