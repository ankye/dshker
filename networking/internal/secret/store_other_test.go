//go:build !darwin && !windows && !linux

package secret

import (
	"errors"
	"testing"
)

func TestRefusesWithoutAProvider(t *testing.T) {
	if _, err := Open(t.TempDir()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("open = %v, want p2p.secret_provider_unavailable", err)
	}
}
