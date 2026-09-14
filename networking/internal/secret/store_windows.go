//go:build windows

package secret

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The DPAPI provider reads and writes one private file under the data root:
// each value is protected with CryptProtectData for the current user, so the
// file on disk contains ciphertext only. The core receives the data root as an
// explicit --data argument; Open refuses when it is absent or not a directory.
const blobFileName = "credentials.json"

// Open returns the Windows DPAPI provider rooted at dataRoot.
func Open(dataRoot string) (Store, error) {
	if dataRoot == "" {
		return nil, ErrUnavailable
	}
	info, err := os.Stat(dataRoot)
	if err != nil || !info.IsDir() {
		return nil, ErrUnavailable
	}
	return &dpapiStore{path: filepath.Join(dataRoot, blobFileName)}, nil
}

type dpapiStore struct {
	// mu serializes read-modify-write cycles. The design (D5) names one writer
	// per store — the core process — and D6 guarantees one core per data root;
	// the mutex makes concurrent callers inside that process safe as well. The
	// whole file is replaced atomically, so a reader either sees the previous
	// complete store or the next one, never a torn record.
	mu   sync.Mutex
	path string
}

func (store *dpapiStore) Get(key string) ([]byte, error) {
	blobs, err := store.read()
	if err != nil {
		return nil, err
	}
	encoded, ok := blobs[key]
	if !ok {
		return nil, ErrMissing
	}
	protected, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, ErrRead
	}
	value, err := dpapiUnprotect(protected)
	if err != nil {
		return nil, ErrRead
	}
	return value, nil
}

func (store *dpapiStore) Set(key string, value []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	blobs, err := store.read()
	if err != nil && !errors.Is(err, ErrMissing) {
		return err
	}
	if blobs == nil {
		blobs = map[string]string{}
	}
	protected, err := dpapiProtect(value)
	if err != nil {
		return ErrWrite
	}
	blobs[key] = base64.StdEncoding.EncodeToString(protected)
	return store.setBlobs(blobs)
}

func (store *dpapiStore) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	blobs, err := store.read()
	if errors.Is(err, ErrMissing) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, ok := blobs[key]; !ok {
		return nil
	}
	delete(blobs, key)
	return store.setBlobs(blobs)
}

// replaceBudget bounds how long a write waits for an open handle to release the
// destination, and replaceDelay is how often it retries inside that budget.
const (
	replaceBudget = 250 * time.Millisecond
	replaceDelay  = time.Millisecond
)

// setBlobs replaces the whole file atomically. Design decision D5 names one
// writer per store, so the core is the only process that touches this file.
func (store *dpapiStore) setBlobs(blobs map[string]string) error {
	data, err := json.Marshal(blobs)
	if err != nil {
		return ErrWrite
	}
	temporary := store.path + ".tmp"
	if err = os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("%w: %v", ErrWrite, err)
	}
	if err = store.replace(temporary); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("%w: %v", ErrWrite, err)
	}
	return nil
}

// replace renames the replacement over the blob, retrying only the transient
// Windows refusals. Windows refuses to replace a destination that *any* open
// handle holds — measured on this platform with both os.Rename and MoveFileEx,
// and FILE_SHARE_DELETE on the reader does not lift it — so a concurrent Get
// that is microseconds from finishing made a Set fail with
// p2p.secret_write_failed and lose the value. Without the retry that was two to
// three failures in five runs of TestStressConcurrentStoreOperations; with it,
// six runs pass and the write only fails when a handle really does not go away
// inside the budget.
func (store *dpapiStore) replace(temporary string) error {
	deadline := time.Now().Add(replaceBudget)
	var err error
	for {
		if err = os.Rename(temporary, store.path); err == nil {
			return nil
		}
		if !sharingViolation(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(replaceDelay)
	}
}

// sharingViolation reports the Windows errors a replace hits while another
// handle still holds the destination: a denial, or an explicit sharing or lock
// violation. Anything else is a real failure and is reported immediately.
func sharingViolation(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

func (store *dpapiStore) read() (map[string]string, error) {
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrMissing
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRead, err)
	}
	var blobs map[string]string
	if err = json.Unmarshal(data, &blobs); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRead, err)
	}
	return blobs, nil
}

func dataBlob(data []byte) windows.DataBlob {
	if len(data) == 0 {
		var zero byte
		return windows.DataBlob{Size: 0, Data: &zero}
	}
	return windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
}

func dpapiProtect(value []byte) ([]byte, error) {
	input := dataBlob(value)
	var output windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, nil, 0, nil, 0, &output); err != nil {
		return nil, err
	}
	// The deferred LocalFree runs before the caller sees the returned value, so
	// the output must be copied into Go memory first.
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return bytes.Clone(unsafe.Slice(output.Data, output.Size)), nil
}

func dpapiUnprotect(protected []byte) ([]byte, error) {
	input := dataBlob(protected)
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(&input, nil, nil, 0, nil, 0, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return bytes.Clone(unsafe.Slice(output.Data, output.Size)), nil
}
