//go:build windows

package remoteroute

import (
	"os/exec"
	"strconv"
	"syscall"
)

// tunnelProcessAttributes is empty on Windows: the tree is addressed through
// taskkill rather than through a group identifier.
func tunnelProcessAttributes() *syscall.SysProcAttr { return nil }

// terminateTunnelTree stops the whole forwarding tree.
func terminateTunnelTree(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return exec.Command("taskkill", "/pid", strconv.Itoa(command.Process.Pid), "/t", "/f").Run()
}
