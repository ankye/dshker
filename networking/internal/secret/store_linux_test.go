//go:build linux

package secret

import (
	"errors"
	"strconv"
	"testing"
	"time"
)

// TestSecretServiceRoundTripsThroughTheKeyring is 3.3's acceptance sentence on a
// machine that has a real keyring: a credential written through one store is
// read back through a freshly opened one, which is what a later run of the core
// does, and a deleted item reports itself missing rather than reading as empty.
//
// A machine with no Secret Service (no session bus, or no libsecret tool) skips
// rather than fails: the refusal that case produces is pinned by the
// platform-neutral tests, and the real keyring is what this test is for.
func TestSecretServiceRoundTripsThroughTheKeyring(t *testing.T) {
	if _, err := Open(t.TempDir()); err != nil {
		t.Skipf("no Secret Service on this machine: %v", err)
	}
	key := "dshkerd-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	value := []byte{0x00, 0x01, 0xfe, 0xff, 0x10, 0x00}

	writer, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	t.Cleanup(func() { _ = writer.Delete(key) })
	if err := writer.Set(key, value); err != nil {
		t.Fatalf("set: %v", err)
	}

	reader, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open reader: %v", err)
	}
	read, err := reader.Get(key)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(read) != string(value) {
		t.Fatalf("value = %v, want %v", read, value)
	}

	if err := reader.Delete(key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := reader.Get(key); !errors.Is(err, ErrMissing) {
		t.Fatalf("after delete = %v, want p2p.secret_missing", err)
	}
	// Deleting an item that is already gone is the state the caller asked for.
	if err := reader.Delete(key); err != nil {
		t.Fatalf("second delete: %v", err)
	}
}
