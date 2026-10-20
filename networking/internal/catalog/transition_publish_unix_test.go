//go:build !windows

package catalog

import (
	"os"
	"testing"
)

func denyCatalogReplacement(t *testing.T, store *Store) func() {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Fatal("test.catalog_write_failure_prerequisite: an unprivileged Unix test user is required")
	}
	info, err := os.Stat(store.directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(store.directory, 0o500); err != nil {
		t.Fatal(err)
	}
	restore := func() {
		if err := os.Chmod(store.directory, info.Mode().Perm()); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(restore)
	return restore
}
