//go:build live

package integration

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// All program-phase exits, including an unexpected original-WS EOF during
// injection, retain the first stack before owned test processes are cleaned up.
// This is read-only observation after a failed assertion, never recovery time.
type recoveryProgramFailureObserver struct{ recorded bool }

func (observer *recoveryProgramFailureObserver) capture(failed bool, observe func(context.Context)) {
	if !failed || observer.recorded {
		return
	}
	observer.recorded = true
	ctx, cancel := context.WithTimeout(context.Background(), recoveryInitialDiagnosticBudget)
	defer cancel()
	observe(ctx)
}

func recoveryProgramFailureScope(service, pair string, state peersession.State) recoveryDiagnosticScope {
	scope := recoveryDiagnosticScope{ServiceID: service, PairID: pair}
	if state.PairID == pair && protocol.ValidNonce(state.AttemptID) && protocol.ValidGeneration(state.Generation) {
		scope.AttemptID, scope.Generation = state.AttemptID, state.Generation
	}
	return scope
}

func TestRecoveryProgramFailureObservationIsIndependentBoundedAndOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		observer := recoveryProgramFailureObserver{}
		calls := 0
		observer.capture(false, func(context.Context) { t.Fatal("successful program profile entered failure observation") })
		observer.capture(true, func(ctx context.Context) {
			calls++
			deadline, ok := ctx.Deadline()
			if !ok || deadline.Sub(time.Now()) != 10*time.Second || ctx.Err() != nil {
				t.Fatal("failed program observation lost its independent bounded context")
			}
			<-ctx.Done()
		})
		observer.capture(true, func(context.Context) { t.Fatal("same failed program profile repeated stack observation") })
		if calls != 1 {
			t.Fatal("failure did not preserve one exact observation")
		}
	})
}

func TestRecoveryProgramFailureObservationDoesNotRepeatDeadlineObserver(t *testing.T) {
	observer := recoveryProgramFailureObserver{recorded: true}
	observer.capture(true, func(context.Context) { t.Fatal("deferred diagnostic repeated the existing 45s deadline observer") })
}

func TestRecoveryProgramFailureScopeDoesNotBorrowAnotherAttempt(t *testing.T) {
	service, pair := protocol.NewID(), protocol.NewID()
	state := peersession.State{PairID: pair, AttemptID: protocol.NewNonce(), Generation: 3, Stage: "suspended"}
	if scope := recoveryProgramFailureScope(service, pair, state); !recoveryDiagnosticExact(scope) || scope.AttemptID != state.AttemptID || scope.Generation != state.Generation {
		t.Fatal("program failure lost its actual scoped observation")
	}
	for _, mutate := range []func(*peersession.State){
		func(value *peersession.State) { value.PairID = protocol.NewID() },
		func(value *peersession.State) { value.AttemptID = "" },
		func(value *peersession.State) { value.Generation = 0 },
	} {
		changed := state
		mutate(&changed)
		scope := recoveryProgramFailureScope(service, pair, changed)
		if scope.AttemptID != "" || scope.Generation != 0 || scope.ServiceID != service || scope.PairID != pair {
			t.Fatal("program failure guessed an attempt or changed its authorized direction")
		}
	}
}
