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

// TestKeychainLargeValues pins the reason the store chunks: the security
// tool's interactive -w reader accepts at most 128 bytes per item and silently
// truncates longer input, which corrupted real device credentials (~1KB JSON)
// until chunking landed. Sizes cover the boundaries and multi-chunk values.
func TestKeychainLargeValues(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for _, size := range []int{1, chunkSize - 1, chunkSize, chunkSize + 1, 128, 129, 3 * chunkSize, 2048} {
		key := testKey("large")
		t.Cleanup(func() { _ = store.Delete(key) })
		value := make([]byte, size)
		if _, err = rand.Read(value); err != nil {
			t.Fatalf("rand: %v", err)
		}
		if err = store.Set(key, value); err != nil {
			t.Fatalf("set %d: %v", size, err)
		}
		got, err := store.Get(key)
		if err != nil {
			t.Fatalf("get %d: %v", size, err)
		}
		if !bytes.Equal(got, value) {
			t.Fatalf("round trip %d: got %d bytes, want %d", size, len(got), size)
		}
		// Overwrite with a different size so a stale chunk would be caught.
		replacement := make([]byte, size+chunkSize)
		if _, err = rand.Read(replacement); err != nil {
			t.Fatalf("rand: %v", err)
		}
		if err = store.Set(key, replacement); err != nil {
			t.Fatalf("set again %d: %v", size, err)
		}
		got, err = store.Get(key)
		if err != nil || !bytes.Equal(got, replacement) {
			t.Fatalf("overwrite %d: %d bytes, want %d (%v)", size, len(got), len(replacement), err)
		}
		if err = store.Delete(key); err != nil {
			t.Fatalf("delete %d: %v", size, err)
		}
		if _, err = store.Get(key); !errors.Is(err, ErrMissing) {
			t.Fatalf("deleted %d: %v", size, err)
		}
	}
}
