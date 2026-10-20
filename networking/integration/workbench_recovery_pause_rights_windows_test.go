//go:build live && windows

package integration

import (
	"bytes"
	"context"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Observation only: these are independent explicit queries, never an access
// retry, attach, pause, debugger detach, privilege or policy operation.
func TestWorkbenchRecoveryPauseDebuggerObservationRightsLive(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	if err := recoveryPauseCheck.Find(); err != nil {
		t.Fatal("test.pause_debug_observation_api_unavailable", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	config := recoveryPauseCoreInputs(t, os.Getenv("DSHKER_TEST_CORE_BINARY"))
	core, owner := recoveryPauseStartOwnedCore(t, config)
	peer, before := recoveryPauseRPC(t, ctx, config.State)
	limited, err := recoveryHoldExactProcess(core.cmd.Process.Pid, os.Getpid(), config.Binary)
	must(t, err)
	defer limited.Close()

	queryHandle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.SYNCHRONIZE, false, uint32(limited.Proof().PID))
	if err != nil {
		t.Fatalf("test.pause_explicit_query_handle_unavailable: %v", err)
	}
	query := &recoveryWindowsProcess{handle: queryHandle, executable: config.Binary}
	defer query.Close()
	query.proof, err = query.inspect(limited.Proof().PID)
	must(t, err)
	if query.Proof() != limited.Proof() {
		t.Fatal("test.pause_query_handle_original_identity_mismatch")
	}
	limitedObservation, limitedErr := recoveryPauseObserveDebugger(limited)
	queryObservation, queryErr := recoveryPauseObserveDebugger(query)
	t.Logf("program-pause-debugger-observation identity=%s limitedAccess=%d queryAccess=%d limited=%s query=%s limitedError=%q queryError=%q diagnosticOnly=true attachPerformed=false pausePerformed=false policyChanged=false", recoveryJSON(t, limited.Proof()), windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, windows.PROCESS_QUERY_INFORMATION|windows.SYNCHRONIZE, recoveryJSON(t, limitedObservation), recoveryJSON(t, queryObservation), recoveryPauseObservationError(limitedErr), recoveryPauseObservationError(queryErr))
	if queryErr != nil {
		t.Errorf("test.pause_explicit_query_observation_failed: %v", queryErr)
	}
	alive, err := limited.Alive()
	must(t, err)
	if !alive {
		t.Fatal("test.pause_observation_core_not_alive")
	}
	after, err := peer.Call(ctx, "core.version", struct{}{})
	must(t, err)
	if !bytes.Equal(before, after) {
		t.Fatal("test.pause_observation_original_rpc_changed")
	}
	must(t, owner.closeBounded())
	t.Log("program-pause-debugger-observation-cleanup exactOwner=true authenticatedShutdown=true ownerExited=true originalCoreHandleAlive=true originalAuthenticatedRPC=true attachPerformed=false pausePerformed=false policyChanged=false")
}

func recoveryPauseObservationError(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
