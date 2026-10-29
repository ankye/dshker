//go:build darwin || windows || linux

package secret

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"
)

// exerciseNativeNamespaces talks to the actual platform provider. Both stores
// intentionally use the same data root and the real logical credential names;
// only unique regression namespaces distinguish them. Existing user items in
// the legacy dshkerd service are never read, written, or deleted by this test.
func exerciseNativeNamespaces(t *testing.T) {
	t.Helper()
	identity := make([]byte, 16)
	if _, err := rand.Read(identity); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	firstNamespace := "regression-" + hex.EncodeToString(identity) + "-a"
	secondNamespace := "regression-" + hex.EncodeToString(identity) + "-b"
	first, err := OpenNamespace(root, firstNamespace)
	if err != nil {
		t.Fatal(err)
	}
	second, err := OpenNamespace(root, secondNamespace)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"machine.device-key", "account.session"} {
		key := key
		t.Cleanup(func() {
			if err := first.Delete(key); err != nil {
				t.Errorf("first isolated namespace cleanup: %v", err)
			}
			if err := second.Delete(key); err != nil {
				t.Errorf("second isolated namespace cleanup: %v", err)
			}
		})
		// Long values exercise Keychain header and every numbered chunk, rather
		// than proving isolation only for a one-item value.
		original := bytes.Repeat([]byte("original-profile:"+key), 80)
		replacement := bytes.Repeat([]byte("second-profile:"+key), 93)
		if err := first.Set(key, original); err != nil {
			t.Fatal(err)
		}
		if _, err := second.Get(key); !errors.Is(err, ErrMissing) {
			t.Fatalf("second namespace read first profile's %s: %v", key, err)
		}
		if err := second.Delete(key); err != nil {
			t.Fatal(err)
		}
		assertNativeValue(t, first, key, original)
		if err := second.Set(key, replacement); err != nil {
			t.Fatal(err)
		}
		assertNativeValue(t, first, key, original)
		assertNativeValue(t, second, key, replacement)
		// Reopening is the real application restart boundary; the namespace
		// retains its data and cannot borrow the other profile's value.
		fresh, err := OpenNamespace(root, secondNamespace)
		if err != nil {
			t.Fatal(err)
		}
		assertNativeValue(t, fresh, key, replacement)
		if err := fresh.Delete(key); err != nil {
			t.Fatal(err)
		}
		if _, err := second.Get(key); !errors.Is(err, ErrMissing) {
			t.Fatalf("deleted isolated key still present: %s, %v", key, err)
		}
		assertNativeValue(t, first, key, original)
	}
}

func assertNativeValue(t *testing.T, store Store, key string, expected []byte) {
	t.Helper()
	actual, err := store.Get(key)
	if err != nil || !bytes.Equal(actual, expected) {
		t.Fatalf("native profile value changed for %s: %v", key, err)
	}
}
