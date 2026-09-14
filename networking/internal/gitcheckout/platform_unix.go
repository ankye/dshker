//go:build !windows

package gitcheckout

import (
	"fmt"
	"os"
	"syscall"
)

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
