//go:build !windows

package integration

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// coreEndpoint returns a private endpoint the core listener accepts.
func coreEndpoint(t *testing.T) string {
	t.Helper()
	// macOS caps Unix socket paths below the default per-test directory name.
	// This directory holds no user data.
	root, err := os.MkdirTemp("", "dshkerd-")
	must(t, err)
	t.Cleanup(func() { os.Remove(filepath.Join(root, "peer.sock")); os.Remove(root) })
	return filepath.Join(root, "peer.sock")
}

func dialCore(endpoint string) (net.Conn, error) {
	return net.DialTimeout("unix", endpoint, 2*time.Second)
}
