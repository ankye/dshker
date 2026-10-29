//go:build windows

package integration

import (
	"os/exec"
	"syscall"
)

func isolationHideCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
