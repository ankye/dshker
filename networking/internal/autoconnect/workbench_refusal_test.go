package autoconnect

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestConnectedWorkbenchRefusalKeepsItsRetryClassification(t *testing.T) {
	for _, code := range []string{"p2p.pair_unauthorized", "p2p.network_revoked", "p2p.runtime_unavailable"} {
		t.Run(code, func(t *testing.T) {
			intent := Intent{ServiceID: "service", PairID: "pair"}
			var connections, delays atomic.Int32
			clock := make(chan time.Time)
			engine := New(Options{
				Intents: func(context.Context) ([]Intent, error) { return []Intent{intent}, nil },
				Stage: func(string, string) ConnectionState {
					return ConnectionState{Stage: "connected", WorkbenchRequested: true, Error: code}
				},
				Connect: func(context.Context, string, string) error { connections.Add(1); return nil },
				CodeOf:  func(err error) string { return err.Error() },
				After:   func(time.Duration) <-chan time.Time { delays.Add(1); return clock },
			})
			defer engine.Close()
			engine.Reconcile(context.Background())
			engine.Reconcile(context.Background())
			engine.mu.Lock()
			refusal, pending := engine.terminal[intent.key()], len(engine.pending)
			engine.mu.Unlock()
			if code == "p2p.runtime_unavailable" {
				if refusal != "" || pending != 1 || connections.Load() != 1 {
					t.Fatalf("temporary workbench refusal lost bounded backoff: refusal=%q pending=%d connections=%d", refusal, pending, connections.Load())
				}
				waitFor(t, func() bool { return delays.Load() == 1 })
			} else if refusal != code || pending != 0 || connections.Load() != 1 || delays.Load() != 0 {
				t.Fatalf("terminal connected refusal was replaced or retried: refusal=%q pending=%d connections=%d", refusal, pending, connections.Load())
			}
		})
	}
}
