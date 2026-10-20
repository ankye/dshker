//go:build live

package integration

import (
	"strings"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func recoveryDiagnosticAdmitted(scope recoveryDiagnosticScope, serviceID, pairID string) bool {
	return scope.ServiceID == serviceID && scope.PairID == pairID &&
		(scope.AttemptID == "" || protocol.ValidNonce(scope.AttemptID))
}

func TestWorkbenchRecoveryDiagnosticAcceptsOnlyCandidateAttemptScope(t *testing.T) {
	const serviceID, pairID = "aaaaaaaaaaaa", "bbbbbbbbbbbb"
	valid := recoveryDiagnosticScope{ServiceID: serviceID, PairID: pairID, AttemptID: strings.Repeat("c", 32), Generation: 2}
	if !recoveryDiagnosticAdmitted(valid, serviceID, pairID) {
		t.Fatal("candidate attempt was refused by the diagnostic endpoint")
	}
	for _, mutate := range []func(*recoveryDiagnosticScope){
		func(scope *recoveryDiagnosticScope) { scope.AttemptID = strings.Repeat("c", 12) },
		func(scope *recoveryDiagnosticScope) { scope.AttemptID = strings.Repeat("g", 32) },
		func(scope *recoveryDiagnosticScope) { scope.ServiceID = "dddddddddddd" },
		func(scope *recoveryDiagnosticScope) { scope.PairID = "eeeeeeeeeeee" },
	} {
		invalid := valid
		mutate(&invalid)
		if recoveryDiagnosticAdmitted(invalid, serviceID, pairID) {
			t.Fatal("legacy attempt or unrelated diagnostic scope was admitted")
		}
	}
	// A failed first connection can have no admitted attempt yet. It still
	// needs an exact service/pair stack, not a fabricated attempt identifier.
	valid.AttemptID = ""
	if !recoveryDiagnosticAdmitted(valid, serviceID, pairID) {
		t.Fatal("initial failure without an admitted attempt lost diagnostics")
	}
}
