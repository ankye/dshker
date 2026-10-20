package autoconnect

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentReconcileClaimsBeforeReadingStage(t *testing.T) {
	var stages, connects atomic.Int32
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	engine := New(Options{
		Intents: func(context.Context) ([]Intent, error) { return []Intent{{"service", "pair"}}, nil },
		Stage: func(string, string) ConnectionState {
			stages.Add(1)
			entered <- struct{}{}
			<-release
			return ConnectionState{}
		},
		Connect: func(context.Context, string, string) error { connects.Add(1); return nil },
	})
	defer engine.Close()
	first, second := make(chan struct{}), make(chan struct{})
	go func() { defer close(first); engine.Reconcile(context.Background()) }()
	<-entered
	go func() { defer close(second); engine.Reconcile(context.Background()) }()
	concurrentStage := false
	select {
	case <-entered:
		concurrentStage = true
	case <-second:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("second reconcile did not settle or reach the exposed claim window")
	}
	close(release)
	<-first
	<-second
	if connects.Load() != 1 || concurrentStage {
		t.Fatalf("concurrent reconciliation read stage %d times and connected %d times; want one atomic claimant", stages.Load(), connects.Load())
	}
}
