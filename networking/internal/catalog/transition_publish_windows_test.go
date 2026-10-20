//go:build windows

package catalog

import (
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

func denyCatalogReplacement(t *testing.T, store *Store) func() {
	t.Helper()
	path, err := windows.UTF16PtrFromString(store.path(recordFile))
	if err != nil {
		t.Fatal(err)
	}
	// A held exact file handle without FILE_SHARE_DELETE permits strict reads
	// but denies replacing/renaming this test-owned record. No ACL is changed.
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	restore := func() {
		once.Do(func() {
			if err := windows.CloseHandle(handle); err != nil {
				t.Error(err)
			}
		})
	}
	t.Cleanup(restore)
	return restore
}
