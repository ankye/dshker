//go:build windows

package localrpc

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// encodeSID renders a *SID in its on-wire byte form so it can be compared with
// the SID embedded in a parsed security descriptor.
func encodeSID(sid *windows.SID) []byte {
	count := sid.SubAuthorityCount()
	buffer := make([]byte, 0, 8+4*int(count))
	buffer = append(buffer, 1, count)
	authority := sid.IdentifierAuthority()
	buffer = append(buffer, authority.Value[:]...)
	for i := uint32(0); i < uint32(count); i++ {
		var value [4]byte
		binary.LittleEndian.PutUint32(value[:], sid.SubAuthority(i))
		buffer = append(buffer, value[:]...)
	}
	return buffer
}

// TestEndpointGuardWindowsDescriptor verifies the security descriptor the
// listener puts on the named pipe: exactly one access-allowed ACE granting
// GENERIC_ALL to the current user and nothing else, so the kernel refuses any
// other OS user that tries to open the pipe.
func TestEndpointGuardWindowsDescriptor(t *testing.T) {
	token := windows.GetCurrentProcessToken()
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatalf("token user: %v", err)
	}
	descriptor := "D:P(A;;GA;;;" + user.User.Sid.String() + ")"
	sd, err := winio.SddlToSecurityDescriptor(descriptor)
	if err != nil {
		t.Fatalf("descriptor must be valid SDDL: %v", err)
	}
	if len(sd) < 20 {
		t.Fatalf("security descriptor too short: %d bytes", len(sd))
	}
	daclOffset := int(binary.LittleEndian.Uint32(sd[16:20]))
	if daclOffset == 0 || daclOffset+8 > len(sd) {
		t.Fatal("no DACL in descriptor")
	}
	// The DACL is an ACL: revision, sbz1, AclSize, AceCount, sbz2, then ACEs.
	dacl := sd[daclOffset:]
	daclSize := int(binary.LittleEndian.Uint16(dacl[2:4]))
	if daclSize < 8 || daclSize != len(dacl) {
		t.Fatalf("DACL size = %d over %d bytes", daclSize, len(dacl))
	}
	aceCount := int(binary.LittleEndian.Uint16(dacl[4:6]))
	if aceCount != 1 {
		t.Fatalf("expected exactly one ACE, got %d", aceCount)
	}
	ace := dacl[8:]
	if len(ace) < 8 {
		t.Fatalf("ACE too short: %d bytes", len(ace))
	}
	if aceType := ace[0]; aceType != windows.ACCESS_ALLOWED_ACE_TYPE {
		t.Fatalf("ACE type = %#x, want access-allowed", aceType)
	}
	aceSize := int(binary.LittleEndian.Uint16(ace[2:4]))
	if aceSize < 12 || aceSize != daclSize-8 {
		t.Fatalf("ACE size = %d, DACL body = %d", aceSize, daclSize-8)
	}
	if mask := binary.LittleEndian.Uint32(ace[4:8]); mask != windows.GENERIC_ALL {
		t.Fatalf("ACE mask = %#x, want GENERIC_ALL", mask)
	}
	want := encodeSID(user.User.Sid)
	if got := ace[8:aceSize]; !bytes.Equal(got, want) {
		t.Fatalf("ACE SID = %x, want %x", got, want)
	}
}

// TestEndpointGuardWindowsRejectsMalformedPaths pins the path rule: the only
// allowed endpoint is a 32-hex suffix on the dshker-peer prefix.
func TestEndpointGuardWindowsRejectsMalformedPaths(t *testing.T) {
	paths := []string{
		"\\\\.\\pipe\\dshker-peer-ZZZZ",
		"\\\\.\\pipe\\dshker-peer-0123456789abcdef0123456789abcdef0",
		"\\\\.\\pipe\\dshker-peer-gggggggggggggggggggggggggggggggg",
		"\\\\other\\pipe\\dshker-peer-0123456789abcdef0123456789abcdef",
	}
	for _, path := range paths {
		if _, err := Listen(path); err == nil || err.Error() != "p2p.invalid_socket" {
			t.Fatalf("%q = %v", path, err)
		}
	}
}
