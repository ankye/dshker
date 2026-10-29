package main

import (
	"os"

	"github.com/ankye/dshker/networking/internal/secret"
)

// Electron explicitly clears this value for stable and supplies a stable
// profile identity for isolated launches. Keeping selection at the composition
// boundary avoids making a provider silently depend on its process environment.
const secretNamespaceEnvironment = "DSHKER_SECRET_NAMESPACE"

func openProfileSecretStore(dataRoot string) (secret.Store, error) {
	return secret.OpenNamespace(dataRoot, os.Getenv(secretNamespaceEnvironment))
}
