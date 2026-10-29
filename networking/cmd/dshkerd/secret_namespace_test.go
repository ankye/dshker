package main

import (
	"errors"
	"testing"

	"github.com/ankye/dshker/networking/internal/secret"
)

func TestProfileSecretStoreRefusesMalformedExplicitNamespace(t *testing.T) {
	t.Setenv(secretNamespaceEnvironment, "../stable")
	if store, err := openProfileSecretStore(t.TempDir()); store != nil || !errors.Is(err, secret.ErrNamespace) {
		t.Fatalf("composition ignored its explicit profile identity: %v", err)
	}
}
