//go:build darwin

package runtimeowner

import (
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const maxRecordedPID = uint64(1<<31 - 1)

func currentBootID() (string, error) {
	value, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return "", ErrOwnerUnavailable
	}
	return bootSessionDigest(value)
}

func recordedProcessExited(expected processIdentity) (bool, error) {
	if !validRecordedProcess(expected) {
		return false, ErrOwnerUnavailable
	}
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.pid", expected.PID)
	if err != nil {
		return false, ErrOwnerUnavailable
	}
	if len(processes) == 0 {
		return true, nil
	}
	if len(processes) != 1 || int(processes[0].Proc.P_pid) != expected.PID {
		return false, ErrOwnerUnavailable
	}
	birth := strconv.FormatInt(processes[0].Proc.P_starttime.Sec, 10) + ":" + strconv.FormatInt(int64(processes[0].Proc.P_starttime.Usec), 10)
	return birth != expected.Creation, nil
}

func validProcessCreation(value string) bool {
	seconds, micros, found := strings.Cut(value, ":")
	sec, secErr := strconv.ParseInt(seconds, 10, 64)
	usec, usecErr := strconv.ParseInt(micros, 10, 32)
	return found && secErr == nil && usecErr == nil && sec > 0 && usec >= 0 && usec < 1000000 && strconv.FormatInt(sec, 10) == seconds && strconv.FormatInt(usec, 10) == micros
}
