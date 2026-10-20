package autoconnect

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestReauthorizeClearsOnlyExactDurableIntentAndPreservesOrdinaryWakeRefusals(t *testing.T) {
	test := newHarness()
	first, other := Intent{"service", "first"}, Intent{"service", "other"}
	test.fail[first.key()], test.fail[other.key()] = "p2p.pair_revoked", "p2p.pair_unauthorized"
	engine := test.engine([]Intent{first, other})
	defer engine.Close()
	engine.Reconcile(context.Background())
	engine.Wake(first)
	engine.Reconcile(context.Background())
	if test.attemptCount() != 2 {
		t.Fatal("ordinary lifecycle wake cleared a terminal refusal")
	}
	test.mu.Lock()
	delete(test.fail, first.key())
	test.mu.Unlock()
	engine.Reauthorize(first)
	waitFor(t, func() bool { return test.attemptCount() == 3 })
	if _, blocked := engine.Refusal(first.ServiceID, first.PairID); blocked {
		t.Fatal("fresh exact authorization retained its old terminal")
	}
	if code, blocked := engine.Refusal(other.ServiceID, other.PairID); !blocked || code != "p2p.pair_unauthorized" {
		t.Fatal("one fresh authorization cleared another intent's terminal", code)
	}
}

func TestReauthorizeFencesOldInflightRefusalAndKeepsOneConnectOwner(t *testing.T) {
	intent := Intent{"service", "computer"}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls, simultaneous, maximum atomic.Int32
	var connected atomic.Bool
	engine := New(Options{
		Intents: func(context.Context) ([]Intent, error) { return []Intent{intent}, nil },
		Stage: func(string, string) ConnectionState {
			if connected.Load() {
				return ConnectionState{Stage: "connected"}
			}
			return ConnectionState{}
		},
		Connect: func(context.Context, string, string) error {
			n := simultaneous.Add(1)
			defer simultaneous.Add(-1)
			for previous := maximum.Load(); n > previous && !maximum.CompareAndSwap(previous, n); previous = maximum.Load() {
			}
			if calls.Add(1) == 1 {
				close(entered)
				<-release
				return errors.New("p2p.pair_revoked")
			}
			connected.Store(true)
			return nil
		},
		CodeOf: func(err error) string { return err.Error() },
	})
	defer engine.Close()
	engine.Wake(intent)
	<-entered
	engine.Reauthorize(intent)
	if calls.Load() != 1 {
		t.Fatal("reauthorization ran concurrently with the old scope")
	}
	close(release)
	waitFor(t, func() bool { return connected.Load() })
	if code, blocked := engine.Refusal(intent.ServiceID, intent.PairID); blocked || maximum.Load() != 1 {
		t.Fatal("late old-scope refusal poisoned the new epoch or broke single-flight", code, maximum.Load())
	}
	connected.Store(false)
	engine.Wake(intent)
	waitFor(t, func() bool { return calls.Load() == 3 && connected.Load() })
}
