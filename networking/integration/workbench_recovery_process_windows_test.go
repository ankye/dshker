//go:build live && windows

package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type recoveryWindowsProcess struct {
	handle     windows.Handle
	proof      recoveryProcessProof
	executable string
}

func recoveryHoldExactProcess(pid, parent int, executable string) (recoveryExactProcess, error) {
	if pid <= 0 || parent <= 0 || pid == os.Getpid() || !filepath.IsAbs(executable) || filepath.Clean(executable) != executable {
		return nil, errors.New("test.process_identity_input_invalid")
	}
	// Never admit installed-user processes by name; the caller supplies an exact
	// PID returned from this test's own exec.Cmd or actual runtime.start result.
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil, errors.New("test.process_handle_unavailable")
	}
	process := &recoveryWindowsProcess{handle: handle, executable: executable}
	proof, err := process.inspect(pid)
	if err != nil || proof.ParentPID != parent {
		windows.CloseHandle(handle)
		return nil, errors.New("test.process_identity_mismatch")
	}
	process.proof = proof
	alive, err := process.Alive()
	if err != nil || !alive {
		windows.CloseHandle(handle)
		return nil, errors.New("test.process_not_alive")
	}
	return process, nil
}

func (process *recoveryWindowsProcess) inspect(pid int) (recoveryProcessProof, error) {
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process.handle, &creation, &exit, &kernel, &user); err != nil {
		return recoveryProcessProof{}, errors.New("test.process_creation_unavailable")
	}
	name := make([]uint16, 32768)
	size := uint32(len(name))
	if err := windows.QueryFullProcessImageName(process.handle, 0, &name[0], &size); err != nil || !strings.EqualFold(filepath.Clean(windows.UTF16ToString(name[:size])), process.executable) {
		return recoveryProcessProof{}, errors.New("test.process_executable_mismatch")
	}
	file, err := os.Open(process.executable)
	if err != nil {
		return recoveryProcessProof{}, errors.New("test.process_executable_unreadable")
	}
	hash := sha256.New()
	_, readErr := io.Copy(hash, file)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return recoveryProcessProof{}, errors.New("test.process_executable_hash_failed")
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return recoveryProcessProof{}, errors.New("test.process_parent_snapshot_failed")
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if entry.ProcessID == uint32(pid) {
			return recoveryProcessProof{PID: pid, ParentPID: int(entry.ParentProcessID), Creation: uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime), ExecutableSHA256: hex.EncodeToString(hash.Sum(nil))}, nil
		}
	}
	return recoveryProcessProof{}, errors.New("test.process_parent_not_found")
}

func (process *recoveryWindowsProcess) Proof() recoveryProcessProof { return process.proof }

func (process *recoveryWindowsProcess) Alive() (bool, error) {
	state, err := windows.WaitForSingleObject(process.handle, 0)
	if err != nil {
		return false, errors.New("test.process_handle_wait_failed")
	}
	if state == windows.WAIT_OBJECT_0 {
		return false, nil
	}
	if state == uint32(windows.WAIT_TIMEOUT) {
		return true, nil
	}
	return false, errors.New("test.process_handle_wait_invalid")
}

func (process *recoveryWindowsProcess) Terminate(ctx context.Context) error {
	alive, err := process.Alive()
	if err != nil || !alive {
		return errors.New("test.process_terminate_requires_live_owned_handle")
	}
	current, err := process.inspect(process.proof.PID)
	if err != nil || current != process.proof {
		return errors.New("test.process_identity_changed_before_terminate")
	}
	if err := windows.TerminateProcess(process.handle, 1); err != nil {
		return errors.New("test.process_terminate_failed")
	}
	for {
		state, err := windows.WaitForSingleObject(process.handle, 50)
		if err != nil {
			return errors.New("test.process_termination_wait_failed")
		}
		if state == windows.WAIT_OBJECT_0 {
			return nil
		}
		if ctx.Err() != nil {
			return errors.New("test.process_termination_not_joined")
		}
	}
}

func (process *recoveryWindowsProcess) Close() error { return windows.CloseHandle(process.handle) }
