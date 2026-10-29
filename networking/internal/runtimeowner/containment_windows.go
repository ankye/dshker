//go:build windows

package runtimeowner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const containmentKind = "windows-owner-job-v1"

var (
	jobKernel        = windows.NewLazySystemDLL("kernel32.dll")
	createPrivateJob = jobKernel.NewProc("CreateJobObjectW")
	openPrivateJob   = jobKernel.NewProc("OpenJobObjectW")
	isProcessInJob   = jobKernel.NewProc("IsProcessInJob")
)

type processContainment struct{ handle windows.Handle }

func containmentName(instance string) (*uint16, error) {
	if !hexValue(instance, 32) {
		return nil, ErrOwnerRecordInvalid
	}
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(sid.String() + ":" + instance))
	// State can be shared by desktop/session-0 cores. A Local namespace would
	// mistake another session's still-live job for a missing process tree.
	return windows.UTF16PtrFromString(`Global\DSHKerRuntime-` + hex.EncodeToString(digest[:]))
}

func newProcessContainment(record ownerRecord) (*processContainment, error) {
	name, err := containmentName(record.Instance)
	if err != nil {
		return nil, err
	}
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;" + sid.String() + ")")
	if err != nil {
		return nil, ErrOwnerRecordInvalid
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	value, _, createErr := createPrivateJob.Call(uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(name)))
	if value == 0 {
		return nil, ErrOwnerUnavailable
	}
	handle := windows.Handle(value)
	// x/sys's CreateJobObject wrapper discards ERROR_ALREADY_EXISTS on success.
	// Inspect the raw call's last-error value so no existing object is adopted.
	if errors.Is(createErr, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(handle)
		return nil, ErrOwnerIdentityMismatch
	}
	failed := true
	defer func() {
		if failed {
			windows.CloseHandle(handle)
		}
	}()
	if windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, 0) != nil {
		return nil, ErrOwnerUnavailable
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, ErrOwnerUnavailable
	}
	if err := validateJob(handle); err != nil {
		return nil, err
	}
	// This happens before the private endpoint serves Start. Every descendant
	// inherits this non-breakaway job before it can execute any DSH code.
	if windows.AssignProcessToJobObject(handle, windows.CurrentProcess()) != nil {
		return nil, ErrOwnerUnavailable
	}
	failed = false
	return &processContainment{handle: handle}, nil
}

func validateJob(handle windows.Handle) error {
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return ErrOwnerUnavailable
	}
	sid, err := currentSID()
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		return ErrOwnerRecordInvalid
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if windows.GetAce(dacl, 0, &ace) != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask != 0x1f003f || !sid.Equals((*windows.SID)(unsafe.Pointer(&ace.SidStart))) {
		return ErrOwnerRecordInvalid
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if windows.QueryInformationJobObject(handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)), nil) != nil {
		return ErrOwnerUnavailable
	}
	if limits.BasicLimitInformation.LimitFlags != windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE {
		return ErrOwnerRecordInvalid
	}
	return nil
}

func jobActiveProcesses(handle windows.Handle) (uint32, error) {
	var accounting struct {
		TotalUser, TotalKernel, PeriodUser, PeriodKernel int64
		PageFaults, Total, Active, Terminated            uint32
	}
	if windows.QueryInformationJobObject(handle, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil) != nil {
		return 0, ErrOwnerUnavailable
	}
	return accounting.Active, nil
}

func (guard *processContainment) allChildrenGone([]processIdentity) (bool, error) {
	if err := validateJob(guard.handle); err != nil {
		return false, err
	}
	active, err := jobActiveProcesses(guard.handle)
	return active == 1, err // The current owner is the only admitted survivor.
}

func (guard *processContainment) close(clean bool) {
	if clean {
		var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		if active, err := jobActiveProcesses(guard.handle); err == nil && active == 1 {
			// Admission is already closed and evidence removed. Avoid killing the
			// owner itself on its clean return; no DSH descendant remains.
			_, _ = windows.SetInformationJobObject(guard.handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
		}
	}
	_ = windows.CloseHandle(guard.handle)
}

func recoveryContainmentGone(journal recoveryJournal) (bool, error) {
	if journal.Containment != containmentKind {
		return false, ErrOwnerRecordInvalid
	}
	name, err := containmentName(journal.Owner.Instance)
	if err != nil {
		return false, err
	}
	const queryAndReadControl = 0x0004 | 0x00020000
	value, _, openErr := openPrivateJob.Call(queryAndReadControl, 0, uintptr(unsafe.Pointer(name)))
	if value == 0 {
		if errors.Is(openErr, windows.ERROR_FILE_NOT_FOUND) {
			return true, nil
		}
		return false, ErrOwnerUnavailable
	}
	handle := windows.Handle(value)
	defer windows.CloseHandle(handle) // Never retain a last handle while polling.
	if err := validateJob(handle); err != nil {
		return false, err
	}
	active, err := jobActiveProcesses(handle)
	return active == 0, err
}

func (guard *processContainment) stopAllChildren(ctx context.Context) error {
	if err := validateJob(guard.handle); err != nil {
		return err
	}
	for {
		if ctx.Err() != nil {
			return ErrOwnerShutdown
		}
		members, err := jobProcessIDs(guard.handle)
		if err != nil {
			return err
		}
		for _, pid := range members {
			if pid == uint32(os.Getpid()) {
				continue
			}
			if err := terminateJobMember(guard.handle, pid); err != nil {
				return err
			}
		}
		active, err := jobActiveProcesses(guard.handle)
		if err != nil {
			return err
		}
		if active == 1 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ErrOwnerShutdown
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func jobProcessIDs(job windows.Handle) ([]uint32, error) {
	for capacity := 64; capacity <= 16384; capacity *= 2 {
		// Header is two DWORDs followed by a native ULONG_PTR array.
		buffer := make([]byte, 8+capacity*int(unsafe.Sizeof(uintptr(0))))
		err := windows.QueryInformationJobObject(job, windows.JobObjectBasicProcessIdList, uintptr(unsafe.Pointer(&buffer[0])), uint32(len(buffer)), nil)
		if errors.Is(err, windows.ERROR_MORE_DATA) {
			continue
		}
		if err != nil {
			return nil, ErrOwnerUnavailable
		}
		count := *(*uint32)(unsafe.Pointer(&buffer[4]))
		if count > uint32(capacity) {
			return nil, ErrOwnerUnavailable
		}
		ids := unsafe.Slice((*uintptr)(unsafe.Pointer(&buffer[8])), int(count))
		result := make([]uint32, 0, count)
		for _, id := range ids {
			if id == 0 || uint64(id) > maxRecordedPID {
				return nil, ErrOwnerUnavailable
			}
			result = append(result, uint32(id))
		}
		return result, nil
	}
	return nil, ErrOwnerUnavailable
}

func terminateJobMember(job windows.Handle, pid uint32) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return ErrOwnerShutdown
	}
	defer windows.CloseHandle(handle)
	var member int32
	result, _, _ := isProcessInJob.Call(uintptr(handle), uintptr(job), uintptr(unsafe.Pointer(&member)))
	if result == 0 || member == 0 {
		return ErrOwnerIdentityMismatch
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		state, stateErr := windows.WaitForSingleObject(handle, 0)
		if stateErr != nil || state != uint32(windows.WAIT_OBJECT_0) {
			return ErrOwnerShutdown
		}
	}
	return nil
}

func (guard *processContainment) containedExit() bool { return validateJob(guard.handle) == nil }
