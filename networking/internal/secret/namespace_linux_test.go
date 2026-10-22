//go:build linux && native_secrets

package secret

import (
	"errors"
	"testing"
)

func TestSecretServiceProfileNamespaces(t *testing.T) {
	store, err := OpenNamespace(t.TempDir(), "regression-provider-probe")
	if err == nil {
		_, err = store.Get("absent-provider-probe")
	}
	if err != nil && !errors.Is(err, ErrMissing) {
		t.Fatal(err)
	}
	exerciseNativeNamespaces(t)
}

func TestSecretServiceStableKeepsItsLegacySchema(t *testing.T) {
	service, err := serviceForNamespace("")
	if err != nil || service != "dshkerd" {
		t.Fatalf("stable provider changed its native service: %v", err)
	}
}
