package autoconnect

import (
	"context"
	"testing"
)

func TestRecoverAuthorizationClearsOnlyCurrentExactAuthorizationStop(t *testing.T) {
	for _, code := range []string{"", "p2p.pair_unauthorized", "p2p.pair_revoked", "p2p.pair_not_found", "p2p.network_revoked"} {
		t.Run(code, func(t *testing.T) {
			h := newHarness()
			intent, other := Intent{"service-a", "computer"}, Intent{"service-b", "computer"}
			engine := h.engine([]Intent{intent, other})
			defer engine.Close()
			engine.mu.Lock()
			if code != "" {
				engine.terminal[intent.key()] = code
			}
			engine.terminal[other.key()] = "p2p.pair_revoked"
			engine.mu.Unlock()
			if !engine.RecoverAuthorization(intent) {
				t.Fatal("fresh original authority could not recover its exact authorization stop")
			}
			waitFor(t, func() bool { return h.attemptCount() == 1 })
			engine.mu.Lock()
			epoch, otherEpoch := engine.epochs[intent.key()], engine.epochs[other.key()]
			engine.mu.Unlock()
			if code, blocked := engine.Refusal(other.ServiceID, other.PairID); !blocked || code != "p2p.pair_revoked" || epoch != 1 || otherEpoch != 0 {
				t.Fatal("automatic recovery changed another scope's stop or epoch", code, epoch, otherEpoch)
			}
		})
	}
}

func TestRecoverAuthorizationAtomicallyPreservesNewNonAuthorizationStop(t *testing.T) {
	for _, code := range []string{"p2p.identity_mismatch", "p2p.trust_restore_rejected", "p2p.lease_rejected", "p2p.device_revoked", "p2p.unauthorized", "p2p.direct_unavailable"} {
		t.Run(code, func(t *testing.T) {
			h := newHarness()
			intent := Intent{"service-a", "computer"}
			engine := h.engine([]Intent{intent})
			defer engine.Close()
			engine.mu.Lock()
			engine.terminal[intent.key()] = "p2p.pair_revoked"
			engine.epochs[intent.key()] = 7
			engine.mu.Unlock()
			if observed, _ := engine.Refusal(intent.ServiceID, intent.PairID); observed != "p2p.pair_revoked" {
				t.Fatal("missing pre-read authorization stop")
			}
			// The coordinator read completed, but a newer refusal won before the
			// recovery publication. The engine must compare its current stop.
			engine.mu.Lock()
			engine.terminal[intent.key()] = code
			done := make(chan bool, 1)
			go func() { done <- engine.RecoverAuthorization(intent) }()
			engine.mu.Unlock()
			if <-done {
				t.Fatal("stale authorization observation cleared a newer terminal")
			}
			engine.Reconcile(context.Background())
			engine.mu.Lock()
			epoch := engine.epochs[intent.key()]
			engine.mu.Unlock()
			if got, blocked := engine.Refusal(intent.ServiceID, intent.PairID); !blocked || got != code || epoch != 7 || h.attemptCount() != 0 {
				t.Fatal("rejected recovery changed the current stop, epoch or connect owner", got, epoch, h.attemptCount())
			}
		})
	}
}

func TestRecoverAuthorizationRejectsClosedEngine(t *testing.T) {
	h := newHarness()
	intent := Intent{"service-a", "computer"}
	engine := h.engine([]Intent{intent})
	engine.Close()
	if engine.RecoverAuthorization(intent) {
		t.Fatal("closed engine accepted fresh recovery")
	}
}
