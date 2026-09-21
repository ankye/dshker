package localrpc

import (
	"context"
	"os"
	"runtime"
	"testing"
	"time"
)

func TestOwnerLockExcludesSecondHostAndHandsOff(t *testing.T) {
	state := stateDirectory(t)
	first, err := AcquireOwnerLock(context.Background(), state, false)
	if err != nil {
		t.Fatalf("first owner: %v", err)
	}
	defer first.Release()
	if _, err := AcquireOwnerLock(context.Background(), state, false); err == nil || err.Error() != "p2p.owner_busy" {
		t.Fatalf("second owner = %v, want p2p.owner_busy", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		second, err := AcquireOwnerLock(ctx, state, true)
		if err == nil {
			defer second.Release()
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("waiting owner returned before release: %v", err)
	case <-time.After(250 * time.Millisecond):
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("handoff = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("waiting owner did not acquire after handoff")
	}
}

func TestOwnerLockRejectsRelativeOrInsecureState(t *testing.T) {
	if _, err := AcquireOwnerLock(context.Background(), "relative", false); err == nil || err.Error() != "p2p.invalid_arguments" {
		t.Fatalf("relative state = %v", err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	state := stateDirectory(t)
	if err := os.Chmod(state, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireOwnerLock(context.Background(), state, false); err == nil || err.Error() != "p2p.insecure_socket_directory" {
		t.Fatalf("insecure state = %v", err)
	}
}

func TestOwnerLockWaitHonorsCancellation(t *testing.T) {
	state := stateDirectory(t)
	first, err := AcquireOwnerLock(context.Background(), state, false)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := AcquireOwnerLock(ctx, state, true); err == nil || err.Error() != "p2p.request_cancelled" {
		t.Fatalf("cancelled wait = %v", err)
	}
}
