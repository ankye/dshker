//go:build !windows

package harnessruntime

import (
	"syscall"
)

// signalTerminatePort asks one leftover process to stop.
func signalTerminatePort(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// forceTerminatePort stops a leftover process that ignored the request.
func forceTerminatePort(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }

// processIsAlive reports whether one process still exists.
func processIsAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// processGroupAttributes makes the child the leader of its own group, so one
// signal reaches pnpm and the DSH Node process it starts rather than only the
// intermediate process.
func processGroupAttributes() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

// terminateProcessTree signals the whole group rooted at one child.
func terminateProcessTree(pid int, force bool) error {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	return syscall.Kill(-pid, signal)
}
