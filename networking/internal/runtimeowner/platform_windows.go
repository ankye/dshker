//go:build windows

package runtimeowner

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func ownerSocket(string) (string, string, error) {
	value, err := randomHex(16)
	return `\\.\pipe\dshker-peer-` + value, "", err
}

func validateOwnerEndpoint(record ownerRecord) error {
	const prefix = `\\.\pipe\dshker-peer-`
	if record.SocketDirectory != "" || !strings.HasPrefix(record.Socket, prefix) || !hexValue(strings.TrimPrefix(record.Socket, prefix), 32) {
		return ErrOwnerRecordInvalid
	}
	return nil
}

func cleanupOwnerEndpoint(record ownerRecord) error { return validateOwnerEndpoint(record) }

func detachedAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS, HideWindow: true}
}

func finalLink(info os.FileInfo) bool {
	attributes, valid := info.Sys().(*syscall.Win32FileAttributeData)
	return info.Mode()&os.ModeSymlink != 0 || (valid && attributes.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

func processIdentityAt(pid int) (processIdentity, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return processIdentity{}, ErrOwnerUnavailable
	}
	defer windows.CloseHandle(handle)
	var creation, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user) != nil {
		return processIdentity{}, ErrOwnerUnavailable
	}
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		return processIdentity{}, ErrOwnerUnavailable
	}
	return processIdentity{PID: pid, Creation: strconv.FormatUint(uint64(creation.HighDateTime)<<32|uint64(creation.LowDateTime), 10)}, nil
}

func currentSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, ErrOwnerRecordInvalid
	}
	return user.User.Sid, nil
}

func secureCreatedPath(path string, directory bool) error {
	sd, err := privateSecurityDescriptor(directory)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return recordFailure("acl-descriptor", err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return recordFailure("acl-set", err)
	}
	return checkPrivatePath(path, directory)
}

func privateSecurityDescriptor(directory bool) (*windows.SECURITY_DESCRIPTOR, error) {
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + sid.String() + ")")
	if err != nil {
		return nil, ErrOwnerRecordInvalid
	}
	return sd, nil
}

func createPrivateDirectory(path string) error {
	sd, err := privateSecurityDescriptor(true)
	if err != nil {
		return err
	}
	name, err := windowsFileName(path)
	if err != nil {
		return err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	// The directory becomes visible with its final protected DACL. An EEXIST
	// observer can validate it immediately; there is no mkdir-to-SetACL window.
	return windows.CreateDirectory(name, &attributes)
}

func windowsFileName(path string) (*uint16, error) {
	name, err := windows.UTF16PtrFromString(extendedWindowsPath(path))
	if err != nil {
		return nil, ErrOwnerRecordInvalid
	}
	return name, nil
}

func extendedWindowsPath(path string) string {
	// Every path is explicit and absolute. The extended spelling preserves long
	// registered roots without switching transport or choosing another directory.
	if !strings.HasPrefix(path, `\\?\`) {
		if strings.HasPrefix(path, `\\`) {
			path = `\\?\UNC\` + strings.TrimPrefix(path, `\\`)
		} else {
			path = `\\?\` + path
		}
	}
	return path
}

type recordRenameInfo struct {
	Flags          uint32
	RootDirectory  windows.Handle
	FileNameLength uint32
	FileName       [1]uint16
}

func recordRenameInformation(destination string) ([]byte, error) {
	name, err := windows.UTF16FromString(extendedWindowsPath(destination))
	if err != nil {
		return nil, ErrOwnerRecordInvalid
	}
	var layout recordRenameInfo
	buffer := make([]byte, int(unsafe.Offsetof(layout.FileName))+len(name)*2)
	info := (*recordRenameInfo)(unsafe.Pointer(&buffer[0]))
	info.Flags = windows.FILE_RENAME_REPLACE_IF_EXISTS | windows.FILE_RENAME_POSIX_SEMANTICS
	info.FileNameLength = uint32((len(name) - 1) * 2)
	copy(unsafe.Slice(&info.FileName[0], len(name)), name)
	return buffer, nil
}

func publishRecordFile(source, destination string) error {
	if filepath.Dir(source) != filepath.Dir(destination) {
		return ErrOwnerIdentityMismatch
	}
	name, err := windowsFileName(source)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.DELETE|windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var original windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &original) != nil || original.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return ErrOwnerRecordInvalid
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil || checkPrivateDACL(sd) != nil {
		return ErrOwnerRecordInvalid
	}
	buffer, err := recordRenameInformation(destination)
	if err != nil {
		return err
	}
	err = windows.SetFileInformationByHandle(handle, windows.FileRenameInfoEx, &buffer[0], uint32(len(buffer)))
	return recordRenameResult(err) // The sole publisher: no older API or retry.
}

func recordRenameResult(err error) error {
	if errors.Is(err, windows.ERROR_INVALID_FUNCTION) || errors.Is(err, windows.ERROR_NOT_SUPPORTED) || errors.Is(err, windows.ERROR_CALL_NOT_IMPLEMENTED) || errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return errors.Join(ErrOwnerProtocol, err)
	}
	return err
}

func openRecordFile(path string) (*os.File, error) {
	name, err := windowsFileName(path)
	if err != nil {
		return nil, err
	}
	// A reader must not prevent atomic publication of the next complete record.
	// It still sees its original file object; a later reader sees the replacement.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		windows.CloseHandle(handle)
		return nil, ErrOwnerRecordInvalid
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil || checkPrivateDACL(sd) != nil {
		windows.CloseHandle(handle)
		return nil, ErrOwnerRecordInvalid
	}
	return os.NewFile(uintptr(handle), path), nil
}

func checkPrivatePath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if finalLink(info) || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return ErrOwnerRecordInvalid
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return recordFailure("acl-read", err)
	}
	return checkPrivateDACL(sd)
}

func checkPrivateDACL(sd *windows.SECURITY_DESCRIPTOR) error {
	sid, err := currentSID()
	if err != nil || sd == nil {
		return ErrOwnerRecordInvalid
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		return ErrOwnerRecordInvalid
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if windows.GetAce(dacl, 0, &ace) != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask != 0x1f01ff || !sid.Equals((*windows.SID)(unsafe.Pointer(&ace.SidStart))) {
		return ErrOwnerRecordInvalid
	}
	return nil
}

func syncRecordDirectory(string) error { return nil }
