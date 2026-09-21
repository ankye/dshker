package main

// Start-at-boot behavior. The platform mechanism is real, so these tests drive the
// actual registration and then remove it; each one restores the machine it ran on.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDesktopAutostartPersistsExactBootRoots(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	if err := SaveConfig(state, Config{Directory: "/checkout", DataRoot: "/old-data", CatalogRoot: "/old-catalog", Roots: "/old-roots"}); err != nil {
		t.Fatal(err)
	}
	authority := desktopAutostart{
		state: state, data: filepath.Join(t.TempDir(), "data"),
		catalog: filepath.Join(t.TempDir(), "catalog"),
	}
	if err := authority.prepare(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	stored, err := LoadConfig(state)
	if err != nil {
		t.Fatal(err)
	}
	if stored.DataRoot != authority.data || stored.CatalogRoot != authority.catalog || stored.Roots != "" {
		t.Fatalf("boot roots = %+v; want exact desktop roots without stale CA", stored)
	}
	if stored.Directory != "/checkout" {
		t.Fatalf("unrelated headless setting lost: %+v", stored)
	}
}

func TestDesktopAutostartRejectsMissingOrRelativeBootRoots(t *testing.T) {
	valid := desktopAutostart{
		state:   filepath.Join(t.TempDir(), "state"),
		data:    filepath.Join(t.TempDir(), "data"),
		catalog: filepath.Join(t.TempDir(), "catalog"),
	}
	for name, change := range map[string]func(*desktopAutostart){
		"missing state":   func(value *desktopAutostart) { value.state = "" },
		"missing data":    func(value *desktopAutostart) { value.data = "" },
		"missing catalog": func(value *desktopAutostart) { value.catalog = "" },
		"relative state":  func(value *desktopAutostart) { value.state = "state" },
		"relative roots":  func(value *desktopAutostart) { value.roots = "ca.pem" },
	} {
		t.Run(name, func(t *testing.T) {
			value := valid
			change(&value)
			if err := value.prepare(); err == nil || err.Error() != "p2p.autostart_unavailable" {
				t.Fatalf("prepare = %v, want p2p.autostart_unavailable", err)
			}
		})
	}
}

// decodeAutostart reads one command's answer.
func decodeAutostart(t *testing.T, raw string) AutostartState {
	t.Helper()
	var state AutostartState
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &state); err != nil {
		t.Fatalf("autostart answer %q is not a state: %v", raw, err)
	}
	return state
}

// TestAutostartReportsAStateWithoutChangingAnything keeps `status` read-only: an
// operator asking whether boot registration exists must not create it.
func TestAutostartReportsAStateWithoutChangingAnything(t *testing.T) {
	state := t.TempDir()
	before, err := autostartStatus()
	if err != nil {
		t.Fatalf("autostartStatus = %v, want nil", err)
	}
	if before.Installed {
		t.Skip("existing registration may belong to another state or executable")
	}
	var stdout, stderr bytes.Buffer
	if code := runAutostart([]string{"status", "--state", state}, &stdout, &stderr); code != 0 {
		t.Fatalf("status = %d, stderr %s", code, stderr.String())
	}
	reported := decodeAutostart(t, stdout.String())
	if reported.Installed != before.Installed {
		t.Fatalf("status changed installed from %v to %v", before.Installed, reported.Installed)
	}
	if reported.Mechanism == "" {
		t.Fatalf("status reported no mechanism: %+v", reported)
	}
}

// TestAutostartRejectsAnUnknownVerb keeps a typo from being read as one of the
// three real operations.
func TestAutostartRejectsAnUnknownVerb(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runAutostart([]string{"bogus"}, &stdout, &stderr); code == 0 {
		t.Fatalf("unknown verb = 0, want a refusal")
	}
	if got := strings.TrimSpace(stderr.String()); got != "p2p.invalid_arguments" {
		t.Fatalf("stderr = %q, want p2p.invalid_arguments", got)
	}
	if code := runAutostart(nil, &stdout, &stderr); code == 0 {
		t.Fatalf("missing verb = 0, want a refusal")
	}
}

func TestAutostartRejectsRelativeStateBeforeRegistration(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runAutostart([]string{"enable", "--state", "relative-state"}, &stdout, &stderr); code == 0 {
		t.Fatal("relative boot state was accepted")
	}
	if got := strings.TrimSpace(stderr.String()); got != "p2p.invalid_arguments" {
		t.Fatalf("stderr = %q, want p2p.invalid_arguments", got)
	}
}

// TestAutostartRoundTripsOnThisPlatform is the real cycle: enable, confirm, remove,
// confirm. It runs only where a mechanism exists, and it refuses to run at all if
// this machine already has a registration, so a developer's own configuration is
// never destroyed by the suite.
func TestAutostartRoundTripsOnThisPlatform(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skipf("no start-at-boot mechanism is implemented for %s", runtime.GOOS)
	}
	existing, err := autostartStatus()
	if err != nil {
		t.Fatalf("autostartStatus = %v", err)
	}
	if existing.Installed {
		t.Skip("this machine already has a registration; refusing to disturb it")
	}
	state := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupAutostartFixture(executable, state) })

	var stdout, stderr bytes.Buffer
	if code := runAutostart([]string{"enable", "--state", state}, &stdout, &stderr); code != 0 {
		t.Fatalf("enable = %d, stderr %s", code, stderr.String())
	}
	if enabled := decodeAutostart(t, stdout.String()); !enabled.Installed {
		t.Fatalf("enable reported %+v, want installed", enabled)
	}
	// Enabling twice must be idempotent, not a second registration or a failure.
	stdout.Reset()
	if code := runAutostart([]string{"enable", "--state", state}, &stdout, &stderr); code != 0 {
		t.Fatalf("second enable = %d, stderr %s", code, stderr.String())
	}
	if again := decodeAutostart(t, stdout.String()); !again.Installed {
		t.Fatalf("second enable reported %+v, want installed", again)
	}

	stdout.Reset()
	if code := runAutostart([]string{"disable", "--state", state}, &stdout, &stderr); code != 0 {
		t.Fatalf("disable = %d, stderr %s", code, stderr.String())
	}
	if removed := decodeAutostart(t, stdout.String()); removed.Installed {
		t.Fatalf("disable reported %+v, want not installed", removed)
	}
	// Disabling an absent registration is also idempotent.
	stdout.Reset()
	if code := runAutostart([]string{"disable", "--state", state}, &stdout, &stderr); code != 0 {
		t.Fatalf("second disable = %d, stderr %s", code, stderr.String())
	}
}
