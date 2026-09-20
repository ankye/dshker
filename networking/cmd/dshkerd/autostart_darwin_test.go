//go:build darwin

package main

// Darwin-only registration assertions: they read the launchd plist and the plist
// escaper, which exist only on this platform.

import (
	"os"
	"strings"
	"testing"
)

// TestAutostartRegistrationCarriesOnlyTheStateDirectory is the reason this feature
// depends on persisted configuration: the registration must not freeze a copy of
// the checkout or the stores, or reconfiguring the machine would silently leave
// boot starting the old ones.
func TestAutostartRegistrationCarriesOnlyTheStateDirectory(t *testing.T) {
	existing, err := autostartStatus()
	if err != nil {
		t.Fatalf("autostartStatus = %v", err)
	}
	if existing.Installed {
		t.Skip("this machine already has a registration; refusing to disturb it")
	}
	state := t.TempDir()
	t.Cleanup(func() { _ = removeAutostart() })
	if err := installAutostart("/opt/dshkerd/dshkerd", state); err != nil {
		t.Fatalf("installAutostart = %v", err)
	}
	reported, err := autostartStatus()
	if err != nil || !reported.Installed {
		t.Fatalf("status after install = (%+v, %v), want installed", reported, err)
	}
	document, err := os.ReadFile(reported.Path)
	if err != nil {
		t.Fatalf("read registration = %v", err)
	}
	text := string(document)
	for _, required := range []string{"/opt/dshkerd/dshkerd", "serve", "--state", state, "RunAtLoad", "KeepAlive"} {
		if !strings.Contains(text, required) {
			t.Fatalf("registration is missing %q:\n%s", required, text)
		}
	}
	// Nothing else may be baked in; those values live in config.json.
	for _, forbidden := range []string{"--directory", "--pnpm", "--data", "--catalog", "--port"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("registration froze %q, which belongs to the persisted configuration:\n%s", forbidden, text)
		}
	}
}

// TestAutostartEscapesRegistrationPaths keeps a directory containing an
// XML-significant character from producing a malformed registration, which would
// make the machine fail to start at boot with no visible cause.
func TestAutostartEscapesRegistrationPaths(t *testing.T) {
	if escaped := plistEscape(`/tmp/a&b<c>d`); escaped != "/tmp/a&amp;b&lt;c&gt;d" {
		t.Fatalf("plistEscape = %q, want the entities escaped", escaped)
	}
}
