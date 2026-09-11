//go:build windows

package runtimebridge

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"
)

// linkDirectory uses a junction when Windows blocks ordinary symlink creation.
// Junctions exercise the same containment boundary without requiring Developer
// Mode or elevation.
func linkDirectory(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err == nil {
		return
	} else if !errors.Is(err, syscall.EPERM) &&
		!errors.Is(err, syscall.EACCES) &&
		!errors.Is(err, syscall.ERROR_PRIVILEGE_NOT_HELD) {
		t.Fatalf("symlink: %v", err)
	}
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("junction: %v (%s)", err, output)
	}
}
