package autoconnect

// Reconnection for every pair the catalog authorizes.
//
// This moved out of the Electron shell. The behavior was correct there and is
// preserved exactly — the same widening delay, the same terminal-refusal set, the
// same rule that a live or connecting pair is left alone — but the shell was the
// only thing that had it, so a headless host held authorized pairs and never
// re-established one that dropped. A machine with no desktop session is precisely
// the machine that cannot have a user click "connect" again.
//
// The intent is the catalog: an authorized pair should be connected, so a drop is
// followed by a retry rather than by a disconnected tab waiting for a click. Only
// losing authorization stops the attempts.

import (
	"context"
	"sync"
	"time"
)

// Backoff is the widening delay between attempts.
//
// The last interval repeats forever on purpose: the pair stays authorized, so the
// engine keeps trying until it is revoked. Without the repeat, a peer that was
// merely switched off would be abandoned after the final entry and would need a
// human to notice.
var Backoff = []time.Duration{
	1 * time.Second,
	2 * time.Second,
	5 * time.Second,
	15 * time.Second,
	60 * time.Second,
}

// liveStages mean a connection exists or is on its way, so there is nothing to do.
var liveStages = map[string]bool{
	"punching":         true,
	"starting-runtime": true,
	"ready":            true,
}

// terminalCodes will not change by trying again: the pair's authorization is gone,
// so retrying would produce the same refusal and hide the reason.
//
// Leaving `pair_unauthorized` and `network_revoked` out of this set is what once
// turned "removed by another device" into a silent retry loop that never succeeded
// and never said why. `ClearRefusals` still forgets them when this machine's own
// state changes, so a re-authorized pair is attempted again.
var terminalCodes = map[string]bool{
	"p2p.not_enabled":            true,
	"p2p.pair_unauthorized":      true,
	"p2p.network_revoked":        true,
	"p2p.pair_revoked":           true,
	"p2p.pair_not_found":         true,
	"p2p.identity_mismatch":      true,
	"p2p.trust_restore_rejected": true,
	"p2p.lease_rejected":         true,
	"p2p.device_revoked":         true,
	"p2p.unauthorized":           true,
}

// Intent is one pair this machine means to keep connected.
type Intent struct {
	ServiceID string
	PairID    string
}

// key identifies one pair across services.
func (intent Intent) key() string { return intent.ServiceID + ":" + intent.PairID }

// Options are the authorities the engine drives. They are injected so the engine
// can be tested without a coordinator, a transport, or real time.
type Options struct {
	// Intents reports the pairs the catalog currently authorizes.
	Intents func(context.Context) ([]Intent, error)
	// Stage reports the live connection stage for one pair, or "" when unknown.
	Stage func(serviceID string, pairID string) string
	// Connect starts one attempt and returns the refusal code on failure.
	Connect func(ctx context.Context, serviceID string, pairID string) error
	// CodeOf maps one error to its public refusal code.
	CodeOf func(error) string
	// After is the clock, injected so tests do not wait in real time.
	After func(time.Duration) <-chan time.Time
}

// Engine keeps authorized pairs connected.
type Engine struct {
	options  Options
	mu       sync.Mutex
	attempts map[string]int
	terminal map[string]string
	// pending holds one cancel channel per scheduled retry. It is a channel rather
	// than a flag because RetryNow must *cancel* an outstanding wait, not merely
	// reset its counter: a pair already waiting out the final 60 second interval
	// would otherwise keep waiting, which is the opposite of retrying now.
	pending  map[string]chan struct{}
	inFlight map[string]bool
	closed   bool
	cancel   context.CancelFunc
	ctx      context.Context
	wait     sync.WaitGroup
}

// New returns an engine that is not running yet.
func New(options Options) *Engine {
	if options.After == nil {
		options.After = time.After
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{
		options:  options,
		attempts: make(map[string]int),
		terminal: make(map[string]string),
		pending:  make(map[string]chan struct{}),
		inFlight: make(map[string]bool),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Refusal reports why a pair stopped being retried, for a surface to show.
func (engine *Engine) Refusal(serviceID string, pairID string) (string, bool) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	code, found := engine.terminal[Intent{ServiceID: serviceID, PairID: pairID}.key()]
	return code, found
}

// Reconcile brings every authorized pair up to intent once.
//
// Safe to call repeatedly: a pair that is connected, connecting, already in
// flight, or already scheduled is skipped.
func (engine *Engine) Reconcile(ctx context.Context) {
	engine.mu.Lock()
	if engine.closed {
		engine.mu.Unlock()
		return
	}
	engine.mu.Unlock()

	intents, err := engine.options.Intents(ctx)
	if err != nil {
		// No catalog, no intent. A later pass picks it up once it is readable.
		return
	}
	wanted := make(map[string]bool, len(intents))
	for _, intent := range intents {
		wanted[intent.key()] = true
	}
	// A pair that is no longer authorized is forgotten entirely, so a re-added one
	// starts from the first delay rather than inheriting an old backoff.
	engine.mu.Lock()
	for identifier := range engine.attempts {
		if !wanted[identifier] {
			delete(engine.attempts, identifier)
		}
	}
	for identifier := range engine.terminal {
		if !wanted[identifier] {
			delete(engine.terminal, identifier)
		}
	}
	engine.mu.Unlock()

	for _, intent := range intents {
		engine.ensure(intent)
	}
}

// RetryNow clears every backoff and retries immediately.
//
// The caller uses this when the machine itself changed state — network back,
// waking from sleep — where waiting out a 60 second delay would feel broken.
func (engine *Engine) RetryNow(ctx context.Context) {
	engine.mu.Lock()
	engine.attempts = make(map[string]int)
	// Cancel every outstanding wait, so a pair sitting on a long delay is attempted
	// immediately instead of finishing a delay the machine's new state invalidated.
	for identifier, cancel := range engine.pending {
		close(cancel)
		delete(engine.pending, identifier)
	}
	engine.mu.Unlock()
	engine.Reconcile(ctx)
}

// ClearRefusals forgets every terminal refusal so a re-authorized pair is
// attempted again.
func (engine *Engine) ClearRefusals() {
	engine.mu.Lock()
	engine.terminal = make(map[string]string)
	engine.attempts = make(map[string]int)
	engine.mu.Unlock()
}

// Close stops every scheduled retry and waits for in-flight attempts to settle.
func (engine *Engine) Close() {
	engine.mu.Lock()
	if engine.closed {
		engine.mu.Unlock()
		return
	}
	engine.closed = true
	engine.mu.Unlock()
	engine.cancel()
	engine.wait.Wait()
}

// ensure starts one attempt unless the pair needs none.
func (engine *Engine) ensure(intent Intent) {
	identifier := intent.key()
	engine.mu.Lock()
	_, waiting := engine.pending[identifier]
	if engine.closed || engine.inFlight[identifier] || waiting {
		engine.mu.Unlock()
		return
	}
	if _, stopped := engine.terminal[identifier]; stopped {
		engine.mu.Unlock()
		return
	}
	engine.mu.Unlock()

	if engine.options.Stage != nil {
		stage := engine.options.Stage(intent.ServiceID, intent.PairID)
		if liveStages[stage] {
			// Connected or connecting: the attempt counter resets so the next drop
			// retries immediately instead of inheriting an old delay.
			engine.mu.Lock()
			delete(engine.attempts, identifier)
			engine.mu.Unlock()
			return
		}
	}
	engine.attempt(intent)
}

// attempt runs one connection and records what it means.
func (engine *Engine) attempt(intent Intent) {
	identifier := intent.key()
	engine.mu.Lock()
	if engine.closed {
		engine.mu.Unlock()
		return
	}
	engine.inFlight[identifier] = true
	engine.mu.Unlock()

	err := engine.options.Connect(engine.ctx, intent.ServiceID, intent.PairID)

	engine.mu.Lock()
	delete(engine.inFlight, identifier)
	if engine.closed {
		engine.mu.Unlock()
		return
	}
	if err == nil {
		delete(engine.attempts, identifier)
		engine.mu.Unlock()
		return
	}
	code := "p2p.operation_failed"
	if engine.options.CodeOf != nil {
		if mapped := engine.options.CodeOf(err); mapped != "" {
			code = mapped
		}
	}
	if terminalCodes[code] {
		engine.terminal[identifier] = code
		engine.mu.Unlock()
		return
	}
	engine.mu.Unlock()
	// Everything else is transient by assumption: a busy helper, an unreachable
	// peer, a coordinator hiccup. None of them is the user's problem to solve with
	// a button.
	engine.schedule(intent)
}

// schedule waits out this pair's delay and then tries again.
func (engine *Engine) schedule(intent Intent) {
	identifier := intent.key()
	engine.mu.Lock()
	if _, waiting := engine.pending[identifier]; engine.closed || waiting {
		engine.mu.Unlock()
		return
	}
	attempt := engine.attempts[identifier]
	delay := Backoff[len(Backoff)-1]
	if attempt < len(Backoff) {
		delay = Backoff[attempt]
	}
	engine.attempts[identifier] = attempt + 1
	cancel := make(chan struct{})
	engine.pending[identifier] = cancel
	engine.mu.Unlock()

	engine.wait.Add(1)
	go func() {
		defer engine.wait.Done()
		select {
		case <-engine.ctx.Done():
			engine.clearPending(identifier, cancel)
			return
		case <-cancel:
			// RetryNow already removed this entry and is reconciling; attempting here
			// too would double up on the same pair.
			return
		case <-engine.options.After(delay):
		}
		engine.clearPending(identifier, cancel)
		engine.mu.Lock()
		stopped := engine.closed
		engine.mu.Unlock()
		if stopped {
			return
		}
		engine.ensure(intent)
	}()
}

// clearPending removes one scheduled wait, but only if it is still the current one:
// RetryNow may already have replaced it, and deleting a newer entry would let two
// goroutines drive the same pair.
func (engine *Engine) clearPending(identifier string, cancel chan struct{}) {
	engine.mu.Lock()
	if current, found := engine.pending[identifier]; found && current == cancel {
		delete(engine.pending, identifier)
	}
	engine.mu.Unlock()
}
