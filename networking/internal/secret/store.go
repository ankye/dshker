// Package secret stores device credentials in the operating system's protected
// store. There is no plaintext path: when no provider is usable the core
// refuses instead of falling back to a readable file, so a headless machine is
// never left with an unencrypted credential.
package secret

import "errors"

// Codes the shell, the CLI and the diagnostics can distinguish. They follow the
// p2p.* naming rule so they cross the private channel unchanged.
var (
	ErrUnavailable = errors.New("p2p.secret_provider_unavailable")
	ErrMissing     = errors.New("p2p.secret_missing")
	ErrWrite       = errors.New("p2p.secret_write_failed")
	ErrRead        = errors.New("p2p.secret_read_failed")
	ErrDelete      = errors.New("p2p.secret_delete_failed")
)

// Store stores and retrieves small values, the device credential most of all,
// keyed by name. Delete is idempotent: deleting an absent key succeeds.
type Store interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
}
