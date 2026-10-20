//go:build !windows

package integration

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestProcessStopTimeoutReadsBackKillAndWaitAndDoesNotContinue(t *testing.T) {
	binary, err := os.Executable()
	must(t, err)
	command := exec.Command(binary, "-test.run=^TestProcessStopDiagnosticHelper$", "-test.timeout=12s", "-test.v")
	command.Env = append(os.Environ(), "DSHKER_TEST_PROCESS_STOP_DIAGNOSTIC_ROLE=supervisor")
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "process failed to stop within 5 seconds") || !strings.Contains(string(output), `"timedOut":true`) || !strings.Contains(string(output), `"kill":"none"`) || !strings.Contains(string(output), `"wait":"exit_error"`) || !strings.Contains(string(output), `"processExited":true`) || !strings.Contains(string(output), `"copyJoined":true`) || strings.Contains(string(output), "PROCESS_STOP_CONTINUED") {
		t.Fatalf("timeout did not preserve exact kill/Wait evidence and fail immediately: %s", output)
	}
	_, tail, found := strings.Cut(string(output), "receipt=")
	body, _, _ := strings.Cut(tail, "; server-shutdown=")
	var receipt processStopReceipt
	if !found || json.Unmarshal([]byte(body), &receipt) != nil || !receipt.SignalRequested || receipt.Signal != "none" || receipt.ExitCode != -1 {
		t.Fatalf("child timeout receipt was not exact: %s", output)
	}
	t.Logf("child-stop-receipt: %s", receipt.json())
}
