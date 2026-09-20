package autoconnect

// Reconnection behavior. The clock is injected, so these assert the real schedule
// without waiting for it.

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// codedError carries a refusal code the way the product's errors do.
type codedError struct{ code string }

func (err codedError) Error() string { return err.code }

func codeOf(err error) string {
	var coded codedError
	if errors.As(err, &coded) {
		return coded.code
	}
	return ""
}

// harness drives one engine with a controllable clock and recorded attempts.
type harness struct {
	mu       sync.Mutex
	attempts []Intent
	delays   []time.Duration
	stages   map[string]string
	fail     map[string]string
	release  chan time.Time
}

func newHarness() *harness {
	return &harness{
		stages:  make(map[string]string),
		fail:    make(map[string]string),
		release: make(chan time.Time, 64),
	}
}

func (test *harness) engine(intents []Intent) *Engine {
	return New(Options{
		Intents: func(context.Context) ([]Intent, error) { return intents, nil },
		Stage: func(serviceID string, pairID string) string {
			test.mu.Lock()
			defer test.mu.Unlock()
			return test.stages[serviceID+":"+pairID]
		},
		Connect: func(_ context.Context, serviceID string, pairID string) error {
			test.mu.Lock()
			test.attempts = append(test.attempts, Intent{ServiceID: serviceID, PairID: pairID})
			code := test.fail[serviceID+":"+pairID]
			test.mu.Unlock()
			if code != "" {
				return codedError{code: code}
			}
			return nil
		},
		CodeOf: codeOf,
		After: func(delay time.Duration) <-chan time.Time {
			test.mu.Lock()
			test.delays = append(test.delays, delay)
			test.mu.Unlock()
			return test.release
		},
	})
}

func (test *harness) attemptCount() int {
	test.mu.Lock()
	defer test.mu.Unlock()
	return len(test.attempts)
}

func (test *harness) recordedDelays() []time.Duration {
	test.mu.Lock()
	defer test.mu.Unlock()
	return append([]time.Duration(nil), test.delays...)
}

// waitFor polls a condition so a scheduled retry can be observed without sleeping
// for the real delay.
func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not reached in time")
}

// TestConnectsEveryAuthorizedPair is the base intent: authorized means connected.
func TestConnectsEveryAuthorizedPair(t *testing.T) {
	test := newHarness()
	intents := []Intent{{"svc-1", "pair-a"}, {"svc-1", "pair-b"}}
	engine := test.engine(intents)
	defer engine.Close()

	engine.Reconcile(context.Background())

	if test.attemptCount() != 2 {
		t.Fatalf("attempts = %d, want one per authorized pair", test.attemptCount())
	}
}

// TestLiveStageIsLeftAlone keeps a reconcile from re-punching an open hole.
func TestLiveStageIsLeftAlone(t *testing.T) {
	for _, stage := range []string{"punching", "starting-runtime", "ready"} {
		t.Run(stage, func(t *testing.T) {
			test := newHarness()
			test.stages["svc-1:pair-a"] = stage
			engine := test.engine([]Intent{{"svc-1", "pair-a"}})
			defer engine.Close()

			engine.Reconcile(context.Background())

			if test.attemptCount() != 0 {
				t.Fatalf("a %s pair was attempted %d times, want 0", stage, test.attemptCount())
			}
		})
	}
}

// TestDroppedStageIsRetried is the whole reason this moved into the core: a headless
// host must recover a drop with no operator action.
func TestDroppedStageIsRetried(t *testing.T) {
	for _, stage := range []string{"disconnected", "failed", ""} {
		t.Run("stage="+stage, func(t *testing.T) {
			test := newHarness()
			test.stages["svc-1:pair-a"] = stage
			engine := test.engine([]Intent{{"svc-1", "pair-a"}})
			defer engine.Close()

			engine.Reconcile(context.Background())

			if test.attemptCount() != 1 {
				t.Fatalf("attempts = %d, want 1", test.attemptCount())
			}
		})
	}
}

// TestBackoffWidensAndRepeatsItsFinalInterval pins the schedule, including that the
// last delay repeats so an unreachable peer is never abandoned while authorized.
func TestBackoffWidensAndRepeatsItsFinalInterval(t *testing.T) {
	test := newHarness()
	test.fail["svc-1:pair-a"] = "p2p.peer_offline"
	engine := test.engine([]Intent{{"svc-1", "pair-a"}})
	defer engine.Close()

	engine.Reconcile(context.Background())
	// Release each scheduled wait so the next attempt runs, one more time than the
	// table is long: the extra pass must reuse the final interval.
	for index := 0; index < len(Backoff)+1; index++ {
		waitFor(t, func() bool { return len(test.recordedDelays()) == index+1 })
		test.release <- time.Now()
	}
	waitFor(t, func() bool { return len(test.recordedDelays()) >= len(Backoff)+1 })

	delays := test.recordedDelays()
	for index, want := range Backoff {
		if delays[index] != want {
			t.Fatalf("delay %d = %v, want %v (schedule %v)", index, delays[index], want, delays)
		}
	}
	if delays[len(Backoff)] != Backoff[len(Backoff)-1] {
		t.Fatalf("delay after the table = %v, want the final interval %v",
			delays[len(Backoff)], Backoff[len(Backoff)-1])
	}
}

// TestTerminalRefusalStopsTheAttempts covers every code that cannot change by
// retrying, and asserts the set matches the shell's exactly.
func TestTerminalRefusalStopsTheAttempts(t *testing.T) {
	expected := []string{
		"p2p.not_enabled",
		"p2p.pair_unauthorized",
		"p2p.network_revoked",
		"p2p.pair_revoked",
		"p2p.pair_not_found",
		"p2p.identity_mismatch",
		"p2p.trust_restore_rejected",
		"p2p.lease_rejected",
		"p2p.device_revoked",
		"p2p.unauthorized",
	}
	if len(terminalCodes) != len(expected) {
		t.Fatalf("terminal set has %d codes, want the shell's %d", len(terminalCodes), len(expected))
	}
	for _, code := range expected {
		if !terminalCodes[code] {
			t.Fatalf("%s is not treated as terminal", code)
		}
		t.Run(code, func(t *testing.T) {
			test := newHarness()
			test.fail["svc-1:pair-a"] = code
			engine := test.engine([]Intent{{"svc-1", "pair-a"}})
			defer engine.Close()

			engine.Reconcile(context.Background())

			if delays := test.recordedDelays(); len(delays) != 0 {
				t.Fatalf("%s scheduled a retry (%v), want none", code, delays)
			}
			reported, found := engine.Refusal("svc-1", "pair-a")
			if !found || reported != code {
				t.Fatalf("Refusal = (%q, %v), want (%q, true)", reported, found, code)
			}
			// A later reconcile must not resume a stopped pair.
			engine.Reconcile(context.Background())
			if test.attemptCount() != 1 {
				t.Fatalf("attempts = %d after a terminal refusal, want 1", test.attemptCount())
			}
		})
	}
}

// TestTransientRefusalIsRetried is the other half: anything not terminal keeps going.
func TestTransientRefusalIsRetried(t *testing.T) {
	test := newHarness()
	test.fail["svc-1:pair-a"] = "p2p.peer_offline"
	engine := test.engine([]Intent{{"svc-1", "pair-a"}})
	defer engine.Close()

	engine.Reconcile(context.Background())
	waitFor(t, func() bool { return len(test.recordedDelays()) == 1 })
	if _, stopped := engine.Refusal("svc-1", "pair-a"); stopped {
		t.Fatal("a transient refusal was recorded as terminal")
	}
}

// TestClearRefusalsResumesAReauthorizedPair covers the rule that a change in this
// machine's own authorization state forgets the recorded stops.
func TestClearRefusalsResumesAReauthorizedPair(t *testing.T) {
	test := newHarness()
	test.fail["svc-1:pair-a"] = "p2p.pair_unauthorized"
	engine := test.engine([]Intent{{"svc-1", "pair-a"}})
	defer engine.Close()

	engine.Reconcile(context.Background())
	if _, stopped := engine.Refusal("svc-1", "pair-a"); !stopped {
		t.Fatal("the pair was not stopped")
	}

	// Re-authorized: the refusal is forgotten and the pair connects.
	test.mu.Lock()
	delete(test.fail, "svc-1:pair-a")
	test.mu.Unlock()
	engine.ClearRefusals()
	engine.Reconcile(context.Background())

	if test.attemptCount() != 2 {
		t.Fatalf("attempts = %d, want a second attempt after re-authorization", test.attemptCount())
	}
	if _, stopped := engine.Refusal("svc-1", "pair-a"); stopped {
		t.Fatal("the refusal survived ClearRefusals")
	}
}

// TestLosingAuthorizationForgetsThePair keeps a revoked pair from leaving state
// behind that a later re-add would inherit.
func TestLosingAuthorizationForgetsThePair(t *testing.T) {
	test := newHarness()
	test.fail["svc-1:pair-a"] = "p2p.pair_unauthorized"
	authorized := []Intent{{"svc-1", "pair-a"}}
	engine := New(Options{
		Intents: func(context.Context) ([]Intent, error) { return authorized, nil },
		Stage:   func(string, string) string { return "" },
		Connect: func(_ context.Context, serviceID string, pairID string) error {
			test.mu.Lock()
			test.attempts = append(test.attempts, Intent{ServiceID: serviceID, PairID: pairID})
			code := test.fail[serviceID+":"+pairID]
			test.mu.Unlock()
			if code != "" {
				return codedError{code: code}
			}
			return nil
		},
		CodeOf: codeOf,
		After:  func(time.Duration) <-chan time.Time { return test.release },
	})
	defer engine.Close()

	engine.Reconcile(context.Background())
	if _, stopped := engine.Refusal("svc-1", "pair-a"); !stopped {
		t.Fatal("the pair was not stopped")
	}
	// The catalog no longer authorizes it; the recorded stop must be dropped.
	authorized = nil
	engine.Reconcile(context.Background())
	if _, stopped := engine.Refusal("svc-1", "pair-a"); stopped {
		t.Fatal("an unauthorized pair kept its recorded refusal")
	}
}

// TestUnreadableCatalogIsNotAnIntentChange keeps a transient read failure from
// tearing down state a later pass should still have.
func TestUnreadableCatalogIsNotAnIntentChange(t *testing.T) {
	test := newHarness()
	engine := New(Options{
		Intents: func(context.Context) ([]Intent, error) {
			return nil, errors.New("p2p.catalog_unavailable")
		},
		Stage: func(string, string) string { return "" },
		Connect: func(_ context.Context, serviceID string, pairID string) error {
			test.mu.Lock()
			test.attempts = append(test.attempts, Intent{ServiceID: serviceID, PairID: pairID})
			test.mu.Unlock()
			return nil
		},
		CodeOf: codeOf,
		After:  func(time.Duration) <-chan time.Time { return test.release },
	})
	defer engine.Close()

	engine.Reconcile(context.Background())

	if test.attemptCount() != 0 {
		t.Fatalf("attempts = %d with no readable catalog, want 0", test.attemptCount())
	}
}

// TestRetryNowClearsTheBackoff covers the machine-state-changed path, where waiting
// out a 60 second delay would feel broken.
func TestRetryNowClearsTheBackoff(t *testing.T) {
	test := newHarness()
	test.fail["svc-1:pair-a"] = "p2p.peer_offline"
	engine := test.engine([]Intent{{"svc-1", "pair-a"}})
	defer engine.Close()

	engine.Reconcile(context.Background())
	waitFor(t, func() bool { return len(test.recordedDelays()) == 1 })
	// Let the scheduled wait finish so the pair is no longer pending, then advance
	// it once more so its next delay would ordinarily be the second interval.
	test.release <- time.Now()
	waitFor(t, func() bool { return len(test.recordedDelays()) == 2 })
	if delays := test.recordedDelays(); delays[1] != Backoff[1] {
		t.Fatalf("second delay = %v, want %v", delays[1], Backoff[1])
	}

	// Let the second wait finish too, so the pair is idle rather than pending: a
	// pending pair is deliberately not re-attempted, so asserting on it here would
	// be testing the skip rule instead of the backoff reset.
	test.release <- time.Now()
	waitFor(t, func() bool { return len(test.recordedDelays()) == 3 })
	if delays := test.recordedDelays(); delays[2] != Backoff[2] {
		t.Fatalf("third delay = %v, want %v", delays[2], Backoff[2])
	}
	test.release <- time.Now()
	waitFor(t, func() bool { return len(test.recordedDelays()) == 4 })

	// RetryNow discards the accumulated count, so the next scheduled delay starts
	// from the first interval again rather than continuing to widen.
	engine.RetryNow(context.Background())
	waitFor(t, func() bool { return len(test.recordedDelays()) >= 5 })
	if delays := test.recordedDelays(); delays[4] != Backoff[0] {
		t.Fatalf("delay after RetryNow = %v, want the first interval %v (schedule %v)",
			delays[4], Backoff[0], delays)
	}
}

// TestCloseStopsScheduledRetries keeps a stopped engine from touching the transport.
func TestCloseStopsScheduledRetries(t *testing.T) {
	test := newHarness()
	test.fail["svc-1:pair-a"] = "p2p.peer_offline"
	engine := test.engine([]Intent{{"svc-1", "pair-a"}})

	engine.Reconcile(context.Background())
	waitFor(t, func() bool { return len(test.recordedDelays()) == 1 })
	before := test.attemptCount()
	engine.Close()

	// Releasing the wait after Close must not produce another attempt.
	select {
	case test.release <- time.Now():
	default:
	}
	time.Sleep(20 * time.Millisecond)
	if test.attemptCount() != before {
		t.Fatalf("attempts = %d after Close, want %d", test.attemptCount(), before)
	}
	// Closing twice is idempotent.
	engine.Close()
}

// TestReconcileSkipsAPairAlreadyInFlight keeps repeated passes from stacking
// attempts on one pair.
func TestReconcileSkipsAPairAlreadyInFlight(t *testing.T) {
	test := newHarness()
	entered := make(chan struct{})
	hold := make(chan struct{})
	engine := New(Options{
		Intents: func(context.Context) ([]Intent, error) {
			return []Intent{{"svc-1", "pair-a"}}, nil
		},
		Stage: func(string, string) string { return "" },
		Connect: func(_ context.Context, serviceID string, pairID string) error {
			test.mu.Lock()
			test.attempts = append(test.attempts, Intent{ServiceID: serviceID, PairID: pairID})
			count := len(test.attempts)
			test.mu.Unlock()
			if count == 1 {
				close(entered)
				<-hold
			}
			return nil
		},
		CodeOf: codeOf,
		After:  func(time.Duration) <-chan time.Time { return test.release },
	})
	defer engine.Close()

	go engine.Reconcile(context.Background())
	<-entered
	// A second pass while the first attempt is still running must not start another.
	engine.Reconcile(context.Background())
	if test.attemptCount() != 1 {
		t.Fatalf("attempts = %d while one was in flight, want 1", test.attemptCount())
	}
	close(hold)
}
