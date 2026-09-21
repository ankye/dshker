package main

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPrepareEndpointForListenRemovesOnlyStaleSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("named pipes have no filesystem socket")
	}
	state, err := os.MkdirTemp("/tmp", "dshker-socket-")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := filepath.Join(state, "peer.sock")
	t.Cleanup(func() { _ = os.Remove(endpoint); _ = os.Remove(state) })
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := prepareEndpointForListen(endpoint); err != nil {
		t.Fatalf("remove stale socket: %v", err)
	}
	if _, err := os.Lstat(endpoint); !os.IsNotExist(err) {
		t.Fatalf("socket remains: %v", err)
	}
	if err := os.WriteFile(endpoint, []byte("user file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareEndpointForListen(endpoint); err == nil || err.Error() != "p2p.insecure_socket" {
		t.Fatalf("regular file was not refused: %v", err)
	}
	data, err := os.ReadFile(endpoint)
	if err != nil || string(data) != "user file" {
		t.Fatalf("regular file changed: %s, %v", data, err)
	}
}
