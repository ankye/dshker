//go:build !windows

package localrpc

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// testEndpoint returns a private endpoint the Unix listener accepts.
func testEndpoint(t *testing.T) string {
	t.Helper()
	// A short directory: macOS caps Unix socket paths below the default
	// per-test directory name. This directory holds no user data.
	root, err := os.MkdirTemp("", "drpc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(filepath.Join(root, "peer.sock")); os.Remove(root) })
	return filepath.Join(root, "peer.sock")
}

func dialPrivate(endpoint string) (net.Conn, error) {
	return net.DialTimeout("unix", endpoint, 2*time.Second)
}
