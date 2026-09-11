//go:build darwin

package secret

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"
)

func testKey(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return prefix + "." + hex.EncodeToString(buf)
}

func TestKeychainRoundTrip(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	key := testKey("test")
	t.Cleanup(func() { _ = store.Delete(key) })

	if _, err = store.Get(key); !errors.Is(err, ErrMissing) {
		t.Fatalf("missing key = %v", err)
	}

	value := []byte(testKey("device-secret"))
	if err = store.Set(key, value); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := store.Get(key)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !bytes.Equal(got, value) {
		t.Fatalf("round trip = %q, want %q", got, value)
	}

	// Overwriting an existing item must succeed (the -U path), and a second
	// value must not disturb the first.
	second := []byte(testKey("second-secret"))
	if err = store.Set(key, second); err != nil {
		t.Fatalf("set again: %v", err)
	}
	got, err = store.Get(key)
	if err != nil || !bytes.Equal(got, second) {
		t.Fatalf("overwrite = %q %v", got, err)
	}

	// A fresh Open must read the same item: the Keychain persists it, which is
	// the "second run" of the migration check.
	fresh, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	got, err = fresh.Get(key)
	if err != nil || !bytes.Equal(got, second) {
		t.Fatalf("fresh open = %q %v", got, err)
	}

	if err = store.Delete(key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err = store.Get(key); !errors.Is(err, ErrMissing) {
		t.Fatalf("deleted key = %v", err)
	}
	if err = store.Delete(key); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
}
