//go:build windows

package harnessruntime

import (
	"os"

	"golang.org/x/sys/windows"
)

// exitSignal names the signal that ended one child. Windows reports a
// terminate request as an exit code rather than a signal, so the code the
// supervisor already recorded is the whole answer there.
func exitSignal(state *os.ProcessState) string {
	if state == nil {
		return ""
	}
	if state.ExitCode() == int(windows.STATUS_CONTROL_C_EXIT) {
		return "interrupt"
	}
	return ""
}
