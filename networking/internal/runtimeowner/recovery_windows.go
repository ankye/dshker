//go:build windows

package runtimeowner

import (
	"encoding/hex"
	"errors"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maxRecordedPID = uint64(1<<32 - 1)

func currentBootID() (string, error) {
	// SystemBootEnvironmentInformation identifies a kernel boot session, not a
	// wall-clock estimate derived from uptime. Clock changes cannot grant recovery.
	var information struct {
		Identifier [16]byte
		Firmware   uint32
		Padding    uint32
		Flags      uint64
	}
	var returned uint32
	if err := windows.NtQuerySystemInformation(windows.SystemBootEnvironmentInformation, unsafe.Pointer(&information), uint32(unsafe.Sizeof(information)), &returned); err != nil || returned != uint32(unsafe.Sizeof(information)) {
		return "", ErrOwnerUnavailable
	}
	return bootSessionDigest(hex.EncodeToString(information.Identifier[:]))
}

func recordedProcessExited(expected processIdentity) (bool, error) {
	if !validRecordedProcess(expected) {
		return false, ErrOwnerUnavailable
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(expected.PID))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return true, nil
	}
	if err != nil {
		return false, ErrOwnerUnavailable // Access denied is not evidence of death.
	}
	defer windows.CloseHandle(handle)
	var creation, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user) != nil {
		return false, ErrOwnerUnavailable
	}
	birth := strconv.FormatUint(uint64(creation.HighDateTime)<<32|uint64(creation.LowDateTime), 10)
	if birth != expected.Creation {
		return true, nil // This PID now names a different process; never signal it.
	}
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, ErrOwnerUnavailable
	}
	if state == uint32(windows.WAIT_OBJECT_0) {
		return true, nil
	}
	if state == uint32(windows.WAIT_TIMEOUT) {
		return false, nil
	}
	return false, ErrOwnerUnavailable
}

func validProcessCreation(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && parsed > 0 && strconv.FormatUint(parsed, 10) == value
}
