//go:build live

package integration

import (
	"context"
	"sync"
	"testing"

	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestRecoveryMacAutoGenerationExceedsInitialAndLatest(t *testing.T) {
	const initial uint64 = 1_792_389_600_000
	for _, inputs := range [][2]uint64{{initial, 25_000_000_000}, {initial, initial}, {initial - 1, initial + 5}} {
		next, err := recoveryMacNextGeneration(inputs[0], inputs[1])
		if err != nil || next <= inputs[0] || next <= inputs[1] {
			t.Fatal("Mac automatic generation did not exceed both the raw Unix-millisecond initial/current and last issued generation")
		}
	}
	if next, err := recoveryMacNextGeneration(^uint64(0), initial); err == nil || next != 0 {
		t.Fatal("Mac automatic generation wrapped into a stale authority instead of refusing overflow")
	}
}

func TestRecoveryMacAutoCacheRejectsInboundAndStaleAttempts(t *testing.T) {
	pair := protocol.NewID()
	initial := peersession.State{PairID: pair, AttemptID: protocol.NewID(), Generation: 1_792_389_600_000, Stage: "ready", RuntimeGeneration: 1}
	events := make(chan peersession.State, 8)
	owner := &recoveryMacAuto{ctx: context.Background(), events: events, pair: pair, current: initial, started: true, ownedGenerations: map[uint64]string{initial.Generation: initial.AttemptID}}
	observe := func(state peersession.State) {
		owner.Observe(state)
		if actual := <-events; actual != state {
			t.Fatal("the Mac automatic state observer changed the existing event stream")
		}
	}
	// This tests the observer's pure ownership projection, not an ICE session.
	observe(peersession.State{PairID: pair, AttemptID: protocol.NewID(), Generation: initial.Generation + 99, Stage: "ready"})
	if actual, ok := owner.Current(); !ok || actual != initial {
		t.Fatal("an inbound generation not issued by this outbound owner replaced its current cache")
	}
	next := peersession.State{PairID: pair, AttemptID: protocol.NewID(), Generation: initial.Generation + 1, Stage: "punching"}
	owner.ownedGenerations[next.Generation] = ""
	observe(next)
	observe(initial)
	wrongAttempt := next
	wrongAttempt.AttemptID = protocol.NewID()
	observe(wrongAttempt)
	wrongPair := next
	wrongPair.PairID = protocol.NewID()
	observe(wrongPair)
	if actual, ok := owner.Current(); !ok || actual != next {
		t.Fatal("a stale generation or different attempt replaced the owned automatic connection state")
	}
	if owner.Attempts() != 0 {
		t.Fatal("a read-only observation initiated a reconnection")
	}
	refused := next
	refused.Stage, refused.Error = "connected", "runtime.worktree_invalid"
	observe(refused)
	if actual, ok := owner.Current(); !ok || actual != refused {
		t.Fatal("the automatic owner cache lost the exact typed runtime refusal")
	}
}

func TestRecoveryMacAutoCloseJoinsStartedPeriodicWorker(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	owner := &recoveryMacAuto{ctx: ctx, cancel: cancel, started: true, done: make(chan struct{}), engineDone: make(chan struct{})}
	owner.bindEngineLifecycle()
	// Cancellation precedes the worker's first sweep, so no manager/network
	// authority is needed to test the actual periodic worker's join boundary.
	cancel()
	go owner.run()
	owner.Close()
	select {
	case <-owner.done:
	default:
		t.Fatal("Mac automatic owner Close returned before its started periodic worker exited")
	}
}

func TestRecoveryMacAutoCloseBeforeStartJoinsAndPreventsAttempts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	owner := &recoveryMacAuto{ctx: ctx, cancel: cancel, done: make(chan struct{}), engineDone: make(chan struct{})}
	owner.bindEngineLifecycle()
	var callers sync.WaitGroup
	for range 10 {
		callers.Go(owner.Close)
	}
	callers.Wait()
	select {
	case <-owner.done:
	default:
		t.Fatal("Mac automatic owner Close left its periodic owner unjoined")
	}
	select {
	case <-owner.engineDone:
	default:
		t.Fatal("Mac automatic owner Close left its production engine cancellation callback unjoined")
	}
	// A closed real Engine returns before it can inspect the absent catalog.
	owner.engine.Reconcile(context.Background())
	if owner.Attempts() != 0 {
		t.Fatal("a closed Mac automatic owner still initiated a connection")
	}
	if _, available := owner.Current(); available {
		t.Fatal("an owner that never started published an available outbound state")
	}
}
