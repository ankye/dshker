//go:build linux

package runtimeowner

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

const maxRecordedPID = uint64(1<<31 - 1)

func currentBootID() (string, error) {
	value, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", ErrOwnerUnavailable
	}
	return bootSessionDigest(string(value))
}

func recordedProcessExited(expected processIdentity) (bool, error) {
	if !validRecordedProcess(expected) {
		return false, ErrOwnerUnavailable
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(expected.PID) + "/stat")
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, ErrOwnerUnavailable
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return false, ErrOwnerUnavailable
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) <= 19 {
		return false, ErrOwnerUnavailable
	}
	return fields[19] != expected.Creation || fields[0] == "Z" || fields[0] == "X", nil
}

func validProcessCreation(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && strconv.FormatUint(parsed, 10) == value
}
