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
	return dpapiStore{path: filepath.Join(dataRoot, blobFileName)}, nil
}

type dpapiStore struct {
	path string
}

func (store dpapiStore) Get(key string) ([]byte, error) {
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

func (store dpapiStore) Set(key string, value []byte) error {
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

func (store dpapiStore) Delete(key string) error {
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

// setBlobs replaces the whole file atomically. Design decision D5 names one
// writer per store, so the core is the only process that touches this file.
func (store dpapiStore) setBlobs(blobs map[string]string) error {
	data, err := json.Marshal(blobs)
	if err != nil {
		return ErrWrite
	}
	temporary := store.path + ".tmp"
	if err = os.WriteFile(temporary, data, 0o600); err != nil {
		return ErrWrite
	}
	if err = os.Rename(temporary, store.path); err != nil {
		_ = os.Remove(temporary)
		return ErrWrite
	}
	return nil
}

func (store dpapiStore) read() (map[string]string, error) {
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
