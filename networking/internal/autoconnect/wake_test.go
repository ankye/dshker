package autoconnect

import (
	"context"
	"testing"
)

func TestWakeRetriesOnlySuspendedPairWithoutPolling(t *testing.T) {
	test := newHarness()
	first, second := Intent{"svc-1", "pair-a"}, Intent{"svc-1", "pair-b"}
	test.fail[first.key()], test.fail[second.key()] = "p2p.peer_offline", "p2p.peer_offline"
	engine := test.engine([]Intent{first, second})
	engine.Reconcile(context.Background())
	waitFor(t, func() bool { return len(test.recordedDelays()) == 2 })
	engine.mu.Lock()
	otherWait := engine.pending[second.key()]
	engine.mu.Unlock()
	test.mu.Lock()
	test.stages[first.key()] = "suspended"
	test.mu.Unlock()
	engine.Wake(first)
	waitFor(t, func() bool { return test.attemptCount() == 3 })
	engine.mu.Lock()
	otherUnchanged := engine.pending[second.key()] == otherWait
	engine.mu.Unlock()
	if !otherUnchanged {
		t.Fatal("one lifecycle wake reset an unrelated pair's backoff")
	}
	test.mu.Lock()
	last := test.attempts[len(test.attempts)-1]
	test.mu.Unlock()
	if last != first {
		t.Fatal("event-driven reconciliation selected another pair", last)
	}
	engine.Close()
	engine.Wake(first)
	if test.attemptCount() != 3 {
		t.Fatal("closed engine accepted another lifecycle wake")
	}
}
