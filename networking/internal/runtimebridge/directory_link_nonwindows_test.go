//go:build !windows

package runtimebridge

import (
	"os"
	"testing"
)

// linkDirectory creates a real symlink. macOS and Linux allow it in a temp
// directory, so containment is proven against a real link.
func linkDirectory(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
}
