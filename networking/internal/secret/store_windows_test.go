//go:build windows

package secret

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func testKey(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return prefix + "." + hex.EncodeToString(buf)
}

func TestDPAPIRoundTripAndFreshOpen(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	key := testKey("test")

	if _, err = store.Get(key); !errors.Is(err, ErrMissing) {
		t.Fatalf("missing key = %v", err)
	}

	value := []byte(testKey("device-secret"))
	if err = store.Set(key, value); err != nil {
		t.Fatalf("set: %v", err)
	}

	// A fresh Open re-reads the file from disk, which is the "second run" of
	// the migration check: the credential must survive it.
	fresh, err := Open(root)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	got, err := fresh.Get(key)
	if err != nil {
		t.Fatalf("get after fresh open: %v", err)
	}
	if !bytes.Equal(got, value) {
		t.Fatalf("round trip = %q, want %q", got, value)
	}

	// No plaintext on disk: the protected blob must not contain the credential.
	blob, err := os.ReadFile(filepath.Join(root, blobFileName))
	if err != nil {
		t.Fatalf("read blob: %v", err)
	}
	if bytes.Contains(blob, value) {
		t.Fatal("plaintext credential found on disk")
	}

	if err = fresh.Delete(key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err = fresh.Get(key); !errors.Is(err, ErrMissing) {
		t.Fatalf("deleted key = %v", err)
	}
	if err = fresh.Delete(key); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
}

func TestDPAPIRefusesWithoutADataRoot(t *testing.T) {
	if _, err := Open(""); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("open(\"\") = %v", err)
	}
	if _, err := Open(filepath.Join(t.TempDir(), "absent")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("open(absent) = %v", err)
	}
}
