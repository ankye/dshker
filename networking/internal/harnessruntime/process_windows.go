//go:build windows

package harnessruntime

import (
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
)

// stillActive is the exit code Windows reports for a running process.
const stillActive = 259

// signalTerminatePort and forceTerminatePort both use taskkill in tree mode:
// Windows has no process group a negative pid could address, and taskkill is
// what the shell used before the core owned the child.
func signalTerminatePort(pid int) error { return terminateProcessTree(pid, false) }

func forceTerminatePort(pid int) error { return terminateProcessTree(pid, true) }

func terminateProcessTree(pid int, force bool) error {
	// taskkill terminates the whole tree on Windows; its forced mode is the only
	// one that reliably reaches a Node child holding a listening socket.
	_ = force
	return backgroundCommand("taskkill", "/pid", strconv.Itoa(pid), "/t", "/f").Run()
}

// processIsAlive reports whether one process still exists.
func processIsAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	var code uint32
	if windows.GetExitCodeProcess(handle, &code) != nil {
		return false
	}
	return code == stillActive
}

// Keep the supervised console program in the background. Tree termination still
// uses taskkill; creating a console or detaching stdio is not required for it.
func processGroupAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

func backgroundCommand(executable string, arguments ...string) *exec.Cmd {
	command := exec.Command(executable, arguments...)
	command.SysProcAttr = processGroupAttributes()
	return command
}
