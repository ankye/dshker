//go:build windows

package runtimeowner

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestOwnerConfigurationRefusesFinalWindowsJunction(t *testing.T) {
	config := ownerTestConfig(t)
	command := os.Getenv("ComSpec")
	if command == "" {
		t.Fatal("explicit Windows ComSpec is unavailable")
	}
	junction := filepath.Join(config.StateRoot, "selected-junction")
	if err := exec.Command(command, "/c", "mklink", "/J", junction, config.StateRoot).Run(); err != nil {
		t.Fatalf("test-owned junction could not be created: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(junction); err != nil {
			t.Error(err)
		}
	})
	config.DataRoot = junction
	if _, err := configRecord(config); !errors.Is(err, ErrOwnerConfiguration) {
		t.Fatalf("final Windows junction was accepted as a configured root: %v", err)
	}
}

func TestPrivateWindowsDirectoriesAreAtomicallyProtected(t *testing.T) {
	parent := t.TempDir()
	// A broad test-owned parent makes inherited ACLs observably different from
	// the required single-user DACL. Production never changes parent permissions.
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(parent, "atomic-owner")
	if err := createPrivateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	assertProtected := func(path string) {
		t.Helper()
		if err := checkPrivatePath(path, true); err != nil {
			t.Fatalf("directory was visible before its single-user DACL was applied: %v", err)
		}
		actual, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		control, _, err := actual.Control()
		if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
			t.Fatal("new directory inherited a mutable parent DACL instead of its protected DACL")
		}
		acl, _, err := actual.DACL()
		if err != nil || acl == nil || acl.AceCount != 1 {
			t.Fatal("new directory did not atomically receive exactly one explicit owner ACE")
		}
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, 0, &ace) != nil || ace.Header.AceFlags&windows.INHERITED_ACE != 0 || ace.Header.AceFlags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE {
			t.Fatal("new directory depended on an inherited ACE rather than its explicit inheritable owner ACE")
		}
	}
	// This assertion is immediately after CreateDirectoryW, before any security
	// repair call. It checks the atomic creation primitive itself.
	assertProtected(directory)
	start := make(chan struct{})
	results := make(chan error, 6)
	creation := filepath.Join(directory, "creation")
	for range 6 {
		go func() {
			<-start
			if err := privateDirectory(directory); err != nil {
				results <- err
				return
			}
			results <- privateDirectory(creation)
		}()
	}
	close(start)
	for range 6 {
		if err := <-results; err != nil {
			t.Fatalf("concurrent owner/creation directory observer saw an incomplete DACL: %v", err)
		}
	}
	assertProtected(creation)
}

func TestWindowsRecordReaderAllowsAtomicPublication(t *testing.T) {
	config := ownerTestConfig(t)
	path, pending := pendingRecord(t, config)
	published := pending
	var err error
	published.Process, err = processIdentityAt(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	legacySource := filepath.Join(filepath.Dir(path), "legacy-publish-control.tmp")
	if err := os.WriteFile(legacySource, []byte("legacy API sharing control"), 0o600); err != nil {
		legacy.Close()
		t.Fatal(err)
	}
	defer os.Remove(legacySource)
	if err := os.Rename(legacySource, path); err == nil {
		legacy.Close()
		t.Fatal("legacy Windows os.Rename did not reproduce its open-target conflict")
	}
	legacy.Close()
	if retained, err := readRecord(path); err != nil || retained != pending {
		t.Fatal("blocked publication removed or partially changed the pending identity")
	}
	reader, err := openRecordFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	// Keep the old reader open throughout the real publication operation. This
	// forces the exact interleaving, with no scheduling delay or retry loop.
	if err := writeRecord(path, published); err != nil {
		t.Fatalf("safe existing reader blocked atomic owner publication: %v", err)
	}
	oldBytes, err := io.ReadAll(io.LimitReader(reader, maxRecordBytes+1))
	var original ownerRecord
	if err != nil || protocol.DecodeExact(oldBytes, &original) != nil || original != pending {
		t.Fatal("held reader did not retain the complete original pending identity")
	}
	if current, err := readRecord(path); err != nil || current != published {
		t.Fatal("new reader did not observe the complete atomically published owner identity")
	}
}

func TestWindowsRecordRenameInformationLayout(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "owner.json")
	buffer, err := recordRenameInformation(destination)
	if err != nil {
		t.Fatal(err)
	}
	var layout recordRenameInfo
	wantOffset := uintptr(12)
	if unsafe.Sizeof(windows.Handle(0)) == 8 {
		wantOffset = 20
	}
	if unsafe.Offsetof(layout.FileName) != wantOffset {
		t.Fatal("FILE_RENAME_INFO filename offset does not match the Windows ABI")
	}
	info := (*recordRenameInfo)(unsafe.Pointer(&buffer[0]))
	name, err := windows.UTF16FromString(extendedWindowsPath(destination))
	if err != nil {
		t.Fatal(err)
	}
	if info.Flags != windows.FILE_RENAME_REPLACE_IF_EXISTS|windows.FILE_RENAME_POSIX_SEMANTICS || info.RootDirectory != 0 || info.FileNameLength != uint32((len(name)-1)*2) {
		t.Fatal("atomic publisher changed its POSIX flags, root handle or UTF16 byte length")
	}
	if len(buffer) != int(wantOffset)+len(name)*2 || windows.UTF16ToString(unsafe.Slice(&info.FileName[0], len(name))) != extendedWindowsPath(destination) {
		t.Fatal("atomic publisher did not encode the exact explicit destination and terminating NUL")
	}
}

func TestWindowsRecordRenameUnsupportedRemainsTyped(t *testing.T) {
	for _, errno := range []syscall.Errno{windows.ERROR_INVALID_FUNCTION, windows.ERROR_NOT_SUPPORTED, windows.ERROR_CALL_NOT_IMPLEMENTED, windows.ERROR_INVALID_PARAMETER} {
		failure := recordFailure("rename", recordRenameResult(errno))
		var actual syscall.Errno
		if !errors.Is(failure, ErrOwnerProtocol) || errors.Is(failure, ErrOwnerRecordInvalid) || !errors.As(failure, &actual) || actual != errno {
			t.Fatal("unsupported atomic rename lost its typed refusal or original errno")
		}
	}
	failure := recordFailure("rename", recordRenameResult(windows.ERROR_ACCESS_DENIED))
	if !errors.Is(failure, ErrOwnerRecordInvalid) || errors.Is(failure, ErrOwnerProtocol) {
		t.Fatal("an actual rename permission failure was reclassified as unsupported")
	}
	if recordRenameResult(nil) != nil {
		t.Fatal("successful atomic rename acquired a fabricated refusal")
	}
}

func TestWindowsRecordPublisherRejectsCrossDirectory(t *testing.T) {
	config := ownerTestConfig(t)
	path, before := pendingRecord(t, config)
	source := filepath.Join(config.StateRoot, "unowned-source")
	if err := os.WriteFile(source, []byte("not an owner record"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishRecordFile(source, path); !errors.Is(err, ErrOwnerIdentityMismatch) {
		t.Fatalf("publisher admitted a source outside the exact owner directory: %v", err)
	}
	if after, err := readRecord(path); err != nil || after != before {
		t.Fatal("cross-directory publication changed the authorized owner identity")
	}
}
