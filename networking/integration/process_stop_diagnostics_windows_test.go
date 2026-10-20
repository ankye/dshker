//go:build windows

package integration

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Windows has no child os.Interrupt delivery. The real unpiped owner must take
// its explicit Kill branch, read back Wait and continue without a fake timeout.
func TestProcessStopUnpipedWindowsUsesExplicitKill(t *testing.T) {
	binary, err := os.Executable()
	must(t, err)
	command := exec.Command(binary, "-test.run=^TestProcessStopDiagnosticHelper$", "-test.timeout=12s", "-test.v")
	command.Env = append(os.Environ(), "DSHKER_TEST_PROCESS_STOP_DIAGNOSTIC_ROLE=supervisor")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Windows explicit Kill failed: %s", output)
	}
	for _, required := range []string{`"signalRequested":false`, `"killRequested":true`, `"kill":"none"`, `"timedOut":false`, `"waitCompleted":true`, `"wait":"exit_error"`, `"processExited":true`, `"copyJoined":true`, "PROCESS_STOP_CONTINUED"} {
		if !strings.Contains(string(output), required) {
			t.Fatalf("Windows exact-child stop receipt omitted %s: %s", required, output)
		}
	}
}
