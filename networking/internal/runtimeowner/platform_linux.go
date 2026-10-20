//go:build linux

package runtimeowner

import (
	"os"
	"strconv"
	"strings"
)

func processIdentityAt(pid int) (processIdentity, error) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return processIdentity{}, ErrOwnerUnavailable
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return processIdentity{}, ErrOwnerUnavailable
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) <= 19 {
		return processIdentity{}, ErrOwnerUnavailable
	}
	return processIdentity{PID: pid, Creation: fields[19]}, nil
}
