//go:build windows

package gitcheckout

import (
	"fmt"
	"os"
	"syscall"
)

// readFingerprint pins the file identity of one executable. Windows has no inode,
// so the volume serial number stands in for the device and the file index for the
// inode — the same two values Node reports, because the core has to agree with a
// fingerprint the shell may have written.
func readFingerprint(path string, info os.FileInfo) (Fingerprint, error) {
	file, err := os.Open(path)
	if err != nil {
		return Fingerprint{}, fmt.Errorf("%w: Git executable file identity is unavailable.", ErrExecutableInvalid)
	}
	defer file.Close()
	var data syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &data); err != nil {
		return Fingerprint{}, fmt.Errorf("%w: Git executable file identity is unavailable.", ErrExecutableInvalid)
	}
	return Fingerprint{
		Device:                 int64(data.VolumeSerialNumber),
		Inode:                  int64(data.FileIndexHigh)<<32 | int64(data.FileIndexLow),
		Size:                   info.Size(),
		ModifiedAtMilliseconds: info.ModTime().UnixMilli(),
	}, nil
}

// executableBitSatisfied always holds on Windows: the platform has no
// executable bit, and the file being a regular file is the whole requirement.
func executableBitSatisfied(os.FileInfo) bool {
	return true
}

// exitStatus reports the exit code. A Windows process is never signalled, so the
// signal half is always empty.
func exitStatus(state *os.ProcessState) (*int, string) {
	code := state.ExitCode()
	return &code, ""
}
