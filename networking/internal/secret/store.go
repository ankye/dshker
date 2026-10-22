// Package secret stores device credentials in the operating system's protected
// store. There is no plaintext path: when no provider is usable the core
// refuses instead of falling back to a readable file, so a headless machine is
// never left with an unencrypted credential.
package secret

import (
	"errors"
	"regexp"
)

// Codes the shell, the CLI and the diagnostics can distinguish. They follow the
// p2p.* naming rule so they cross the private channel unchanged.
var (
	ErrUnavailable = errors.New("p2p.secret_provider_unavailable")
	ErrMissing     = errors.New("p2p.secret_missing")
	ErrWrite       = errors.New("p2p.secret_write_failed")
	ErrRead        = errors.New("p2p.secret_read_failed")
	ErrDelete      = errors.New("p2p.secret_delete_failed")
	ErrNamespace   = errors.New("p2p.invalid_arguments")
)

const legacyService = "dshkerd"

var namespacePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)

// Open keeps the installed stable application's original provider identity.
// Existing native machine keys and account sessions must remain readable after
// an upgrade; changing the data directory does not rename those native items.
func Open(dataRoot string) (Store, error) { return OpenNamespace(dataRoot, "") }

// OpenNamespace opens an explicitly selected profile. A nonempty namespace is
// part of every native item identity (including macOS chunks), and of Windows'
// encrypted filename. There is no lookup, migration, or deletion in legacy or
// another namespace when an item is absent. Callers choose a stable namespace;
// dataRoot is deliberately not hashed here because stable keeps legacy keys.
func OpenNamespace(dataRoot, namespace string) (Store, error) {
	service, err := serviceForNamespace(namespace)
	if err != nil {
		return nil, err
	}
	return openStore(dataRoot, service)
}

func serviceForNamespace(namespace string) (string, error) {
	if namespace == "" {
		return legacyService, nil
	}
	if !namespacePattern.MatchString(namespace) {
		return "", ErrNamespace
	}
	return legacyService + "." + namespace, nil
}

// Store stores and retrieves small values, the device credential most of all,
// keyed by name. Delete is idempotent: deleting an absent key succeeds.
type Store interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
}
