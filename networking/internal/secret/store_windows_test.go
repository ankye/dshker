//go:build windows

package secret

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
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

// TestReplaceWaitsForAReaderThatClosesQuickly pins the Windows fix end to end.
// Windows refuses to replace a destination that any open handle holds, so the
// write has to wait for a reader that finishes microseconds later instead of
// failing: measured, this is the exact shape of the failure the stress case
// found under load, with the timing made deterministic here.
func TestReplaceWaitsForAReaderThatClosesQuickly(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err = store.Set("key.before", []byte("first")); err != nil {
		t.Fatalf("set: %v", err)
	}
	// A reader of the previous version is open while the next version lands.
	reader, err := os.Open(filepath.Join(root, blobFileName))
	if err != nil {
		t.Fatalf("open blob: %v", err)
	}
	defer func() { _ = reader.Close() }()
	written := make(chan error, 1)
	go func() { written <- store.Set("key.after", []byte("second")) }()

	// The write cannot replace the blob while this reader holds it, so it is
	// still running here rather than reported as a failure.
	select {
	case err := <-written:
		t.Fatalf("the write completed behind an open reader: %v", err)
	case <-time.After(5 * time.Millisecond):
	}

	// The held reader still sees the previous complete store, never a torn one.
	held, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read held blob: %v", err)
	}
	var previous map[string]string
	if err = json.Unmarshal(held, &previous); err != nil {
		t.Fatalf("held blob is not a store: %v", err)
	}
	if _, ok := previous["key.before"]; !ok {
		t.Fatalf("the held reader did not keep the previous store: %s", held)
	}
	if _, ok := previous["key.after"]; ok {
		t.Fatalf("the held reader saw the replacement: %s", held)
	}

	if err = reader.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err = <-written; err != nil {
		t.Fatalf("the write did not survive the reader: %v", err)
	}
	value, err := store.Get("key.after")
	if err != nil || !bytes.Equal(value, []byte("second")) {
		t.Fatalf("after the reader closed: %q, %v", value, err)
	}
	previousValue, err := store.Get("key.before")
	if err != nil || !bytes.Equal(previousValue, []byte("first")) {
		t.Fatalf("the previous key was lost: %q, %v", previousValue, err)
	}
}

// TestReplaceRefusesAForeignHandleThatNeverReleases proves the retry is bounded:
// a handle that did not allow deletion keeps the destination locked, and the
// write is reported as a failure instead of waiting forever.
func TestReplaceRefusesAForeignHandleThatNeverReleases(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err = store.Set("key", []byte("value")); err != nil {
		t.Fatalf("set: %v", err)
	}
	blocker, err := lockWithoutDelete(filepath.Join(root, blobFileName))
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	defer func() { _ = windows.CloseHandle(blocker) }()
	if err = store.Set("key", []byte("other")); !errors.Is(err, ErrWrite) {
		t.Fatalf("a locked destination = %v", err)
	}
}

func TestSharingViolationClassifiesOnlyTransientWindowsErrors(t *testing.T) {
	cases := map[string]struct {
		err       error
		transient bool
	}{
		"a denial":          {windows.ERROR_ACCESS_DENIED, true},
		"a sharing refusal": {windows.ERROR_SHARING_VIOLATION, true},
		"a lock refusal":    {windows.ERROR_LOCK_VIOLATION, true},
		"a missing file":    {windows.ERROR_FILE_NOT_FOUND, false},
		"a full disk":       {windows.ERROR_DISK_FULL, false},
		"a plain error":     {ErrWrite, false},
	}
	for name, expected := range cases {
		if sharingViolation(expected.err) != expected.transient {
			t.Errorf("sharingViolation(%s) = %v", name, !expected.transient)
		}
	}
}

// lockWithoutDelete opens the blob with the share mode Go's own os.OpenFile
// uses, which is exactly the foreign handle that blocks a Windows replace.
func lockWithoutDelete(path string) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.CreateFile(
		name,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
}
