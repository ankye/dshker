//go:build darwin && native_secrets

package secret

import "testing"

func TestKeychainProfileNamespaces(t *testing.T) { exerciseNativeNamespaces(t) }

func TestKeychainStableKeepsItsLegacyService(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil || store.(keychainStore).service != "dshkerd" {
		t.Fatalf("stable provider changed its native service: %v", err)
	}
}
