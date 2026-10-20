//go:build darwin

package runtimeowner

import (
	"strconv"

	"golang.org/x/sys/unix"
)

func processIdentityAt(pid int) (processIdentity, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || info == nil || int(info.Proc.P_pid) != pid {
		return processIdentity{}, ErrOwnerUnavailable
	}
	return processIdentity{PID: pid, Creation: strconv.FormatInt(info.Proc.P_starttime.Sec, 10) + ":" + strconv.FormatInt(int64(info.Proc.P_starttime.Usec), 10)}, nil
}
