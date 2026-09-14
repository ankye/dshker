//go:build !windows

package harnessruntime

import (
	"os"
	"syscall"
)

// exitSignal names the signal that ended one child, or the empty string when it
// exited on its own.
func exitSignal(state *os.ProcessState) string {
	if state == nil {
		return ""
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return ""
	}
	return status.Signal().String()
}
