//go:build !windows

package localrpc

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestEndpointGuardUnixPermissionsAndOwnership pins the honest form of the
// cross-user guarantee on Unix: the socket is mode 0600 inside a mode 0700
// directory owned by the current user, so a different OS user cannot traverse
// the directory, cannot open the socket, and cannot even observe it.
func TestEndpointGuardUnixPermissionsAndOwnership(t *testing.T) {
	endpoint := testEndpoint(t)
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	socketInfo, err := os.Stat(endpoint)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if socketInfo.Mode().Perm() != 0600 {
		t.Fatalf("socket mode = %#o, want 0600", socketInfo.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(endpoint))
	if err != nil {
		t.Fatalf("stat directory: %v", err)
	}
	if dirInfo.Mode().Perm() != 0700 {
		t.Fatalf("directory mode = %#o, want 0700", dirInfo.Mode().Perm())
	}
	if socketSystem, ok := socketInfo.Sys().(*syscall.Stat_t); ok {
		if int(socketSystem.Uid) != os.Geteuid() {
			t.Fatalf("socket owner = %d, want %d", socketSystem.Uid, os.Geteuid())
		}
	}
	if dirSystem, ok := dirInfo.Sys().(*syscall.Stat_t); ok {
		if int(dirSystem.Uid) != os.Geteuid() {
			t.Fatalf("directory owner = %d, want %d", dirSystem.Uid, os.Geteuid())
		}
	}
}

// TestEndpointGuardUnixRefusesUnsafeLayouts keeps the listener from silently
// accepting a layout a different user could follow.
func TestEndpointGuardUnixRefusesUnsafeLayouts(t *testing.T) {
	root := t.TempDir()
	if _, err := Listen("relative/peer.sock"); err == nil || err.Error() != "p2p.invalid_socket" {
		t.Fatalf("relative path = %v", err)
	}
	if _, err := Listen(filepath.Join(root, "other.sock")); err == nil || err.Error() != "p2p.invalid_socket" {
		t.Fatalf("wrong basename = %v", err)
	}
	leaky := filepath.Join(root, "leaky")
	if err := os.Mkdir(leaky, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(filepath.Join(leaky, "peer.sock")); err == nil || err.Error() != "p2p.insecure_socket_directory" {
		t.Fatalf("leaky directory = %v", err)
	}
}
