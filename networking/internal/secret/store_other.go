//go:build !darwin && !windows

package secret

// Open refuses on platforms without a provider. Nothing is persisted and no
// fallback exists, so a headless Linux box cannot silently write a credential
// into a readable file.
func Open(dataRoot string) (Store, error) {
	return nil, ErrUnavailable
}
