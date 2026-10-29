//go:build !darwin && !windows && !linux

package secret

// Open refuses on platforms without a provider. Nothing is persisted and no
// fallback exists, so a headless Linux box cannot silently write a credential
// into a readable file.
func openStore(dataRoot, service string) (Store, error) {
	return nil, ErrUnavailable
}
