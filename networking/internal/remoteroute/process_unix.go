//go:build !windows

package remoteroute

import (
	"os/exec"
	"syscall"
)

// tunnelProcessAttributes makes one forwarding process the leader of its own
// group, so a stop reaches the whole tree.
func tunnelProcessAttributes() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

// terminateTunnelTree signals the group rooted at one forwarding process.
func terminateTunnelTree(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
}
