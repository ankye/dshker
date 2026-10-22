//go:build windows

package secret

import (
	"path/filepath"
	"testing"
)

func TestDPAPIProfileNamespaces(t *testing.T) { exerciseNativeNamespaces(t) }

func TestDPAPIStableKeepsItsLegacyFile(t *testing.T) {
	root := t.TempDir()
	legacy, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.(*dpapiStore).path != filepath.Join(root, blobFileName) {
		t.Fatal("stable provider renamed its existing credential file")
	}
	if err := legacy.Set("account.session", []byte("existing-stable-session")); err != nil {
		t.Fatal(err)
	}
	stable, err := OpenNamespace(root, "")
	if err != nil {
		t.Fatal(err)
	}
	assertNativeValue(t, stable, "account.session", []byte("existing-stable-session"))
}
