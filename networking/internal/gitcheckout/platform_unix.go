//go:build !windows

package gitcheckout

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// configureProcess puts the command in its own process group, so the whole tree
// can be ended together.
func configureProcess(process *exec.Cmd) {
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcess ends the command and everything it started. Killing only the
// process we started is not enough: a git that spawned a helper — or a shell that
// spawned a child — leaves that child holding the output pipe, and the invocation
// would then wait for a process nobody is waiting for. The group is the unit.
func killProcess(process *os.Process) error {
	if process == nil {
		return nil
	}
	if err := syscall.Kill(-process.Pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return process.Kill()
}

// readFingerprint pins the file identity of one executable. Device and inode come
// from the platform, and the two numbers the record stores are whole
// milliseconds, which is what both implementations write and read.
func readFingerprint(_ string, info os.FileInfo) (Fingerprint, error) {
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return Fingerprint{}, fmt.Errorf("%w: Git executable file identity is unavailable.", ErrExecutableInvalid)
	}
	return Fingerprint{
		Device:                 int64(metadata.Dev),
		Inode:                  int64(metadata.Ino),
		Size:                   info.Size(),
		ModifiedAtMilliseconds: info.ModTime().UnixMilli(),
	}, nil
}

// executableBitSatisfied reports whether the file may be executed. On POSIX a
// pinned git has to carry an executable bit; Windows has no such bit.
func executableBitSatisfied(info os.FileInfo) bool {
	return info.Mode().Perm()&0o111 != 0
}

// exitStatus reports the two ways a process can end: a code, or the signal that
// killed it.
func exitStatus(state *os.ProcessState) (*int, string) {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return nil, status.Signal().String()
	}
	code := state.ExitCode()
	return &code, ""
}
