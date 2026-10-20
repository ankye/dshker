package peersession

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestCandidateGraceEngineStageRecoveryBeforeReservationRetainsOriginal(t *testing.T) {
	fixture := newBrowserCandidateFixture(t)
	var requests atomic.Int32
	runtime := browserWorkbenchRuntime(t, "original-workbench-body", &requests)
	old := fixture.promote(t, 1, runtimebridge.Binding{Generation: 1, URL: runtime.URL + "/?token=stage-grace"}, "")
	fixture.manager.mu.Lock()
	old.result.State.Stage = "suspended"
	fixture.manager.mu.Unlock()
	stageRead, connectAllowed := make(chan struct{}), make(chan struct{})
	var captured atomic.Bool
	type result struct {
		candidate *session
		err       error
	}
	answer := make(chan result, 1)
	scheduled := make(chan struct{}, 1)
	intent := autoconnect.Intent{ServiceID: fixture.manager.config.Authority.ServiceID, PairID: fixture.pairID}
	engine := autoconnect.New(autoconnect.Options{
		Intents: func(context.Context) ([]autoconnect.Intent, error) { return []autoconnect.Intent{intent}, nil },
		Stage: func(string, string) autoconnect.ConnectionState {
			state, err := fixture.manager.CurrentState(fixture.pairID)
			if err != nil {
				return autoconnect.ConnectionState{}
			}
			if !captured.Swap(true) {
				close(stageRead)
				<-connectAllowed
			}
			return autoconnect.ConnectionState{Stage: state.Stage, WorkbenchRequested: true}
		},
		Connect: func(context.Context, string, string) error {
			next := prepareGraceResume(t, fixture, 2)
			fixture.transports(t, next)
			err := fixture.manager.awaitCandidateGrace(next)
			answer <- result{next, err}
			return err
		},
		CodeOf: func(err error) string { code, _ := protocol.Refusal(err); return code },
		After:  func(time.Duration) <-chan time.Time { scheduled <- struct{}{}; return make(chan time.Time) },
	})
	t.Cleanup(engine.Close)
	reconciled := make(chan struct{})
	go func() { engine.Reconcile(fixture.manager.ctx); close(reconciled) }()
	select {
	case <-stageRead:
	case <-fixture.manager.ctx.Done():
		t.Fatal(fixture.manager.ctx.Err())
	}
	fixture.manager.mu.Lock()
	old.result.State.Stage = "ready" // No observer callback runs before reservation.
	fixture.manager.mu.Unlock()
	close(connectAllowed)
	var actual result
	select {
	case actual = <-answer:
	case <-fixture.manager.ctx.Done():
		t.Fatal(fixture.manager.ctx.Err())
	}
	<-reconciled
	if actual.err == nil || actual.err.Error() != "p2p.connection_cancelled" || !actual.candidate.predecessorWasSuspended {
		t.Fatal("Stage-to-reservation recovery lost its original authority", actual.err)
	}
	select {
	case <-scheduled:
	case <-fixture.manager.ctx.Done():
		t.Fatal("typed cancellation was not kept transient")
	}
	if _, terminal := engine.Refusal(intent.ServiceID, intent.PairID); terminal {
		t.Fatal("recovered pair became a terminal refusal")
	}
	if _, err := fixture.manager.reserveCandidate(fixture.pairID, 2, false, true); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("overlapping reservation changed generation admission")
	}
	if fixture.manager.sessions[fixture.pairID] != old || old.endpoint.CurrentMux() != old.mux {
		t.Fatal("background recovery replaced the original mux")
	}
	fixture.manager.finish(actual.candidate.PairID, actual.candidate)
	if _, err := fixture.manager.reserveCandidate(fixture.pairID, 2, false, true); err == nil || err.Error() != "p2p.stale_generation" {
		t.Fatal("cancelled recovery reused its admitted generation", err)
	}
}
