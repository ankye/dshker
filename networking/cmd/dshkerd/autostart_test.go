package main

// Start-at-boot behavior. The platform mechanism is real, so these tests drive the
// actual registration and then remove it; each one restores the machine it ran on.

import (
	"bytes"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

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
	t.Cleanup(func() { _ = removeAutostart() })

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
