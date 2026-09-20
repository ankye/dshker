package main

// Persisted-configuration behavior: the precedence rule, the write-back rule, the
// refusal that must survive persistence, and the secret exclusion.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestConfigRoundTripsThroughTheStateDirectory proves a value supplied once is
// readable on a later run, which is the whole point of the file.
func TestConfigRoundTripsThroughTheStateDirectory(t *testing.T) {
	state := t.TempDir()
	if err := SaveConfig(state, Config{Directory: "/checkout", Pnpm: "/bin/pnpm", Port: 3080}); err != nil {
		t.Fatalf("SaveConfig = %v, want nil", err)
	}
	stored, err := LoadConfig(state)
	if err != nil {
		t.Fatalf("LoadConfig = %v, want nil", err)
	}
	if stored.Directory != "/checkout" || stored.Pnpm != "/bin/pnpm" || stored.Port != 3080 {
		t.Fatalf("stored = %+v, want the saved values", stored)
	}
	if stored.Version != 1 {
		t.Fatalf("version = %d, want 1", stored.Version)
	}
}

// TestMissingConfigIsNotAFailure keeps an unconfigured machine usable: absence
// means "resolve from flags or defaults", not an error.
func TestMissingConfigIsNotAFailure(t *testing.T) {
	stored, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig on an empty directory = %v, want nil", err)
	}
	if stored.Directory != "" || stored.Pnpm != "" {
		t.Fatalf("stored = %+v, want zero values", stored)
	}
}

// TestUnparsableConfigIsRefused is the opposite case: a file that exists but
// cannot be read must not be silently treated as "nothing configured", because
// that could start a different checkout than the operator chose.
func TestUnparsableConfigIsRefused(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, ConfigFileName), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed = %v", err)
	}
	if _, err := LoadConfig(state); err == nil || err.Error() != "p2p.invalid_configuration" {
		t.Fatalf("LoadConfig = %v, want p2p.invalid_configuration", err)
	}
}

// TestConfigRejectsAnotherVersion keeps a future format from being read as this
// one, which would silently drop fields this build does not know.
func TestConfigRejectsAnotherVersion(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, ConfigFileName), []byte(`{"version":2}`), 0o600); err != nil {
		t.Fatalf("seed = %v", err)
	}
	if _, err := LoadConfig(state); err == nil || err.Error() != "p2p.invalid_configuration" {
		t.Fatalf("LoadConfig = %v, want p2p.invalid_configuration", err)
	}
}

// TestConfigFileIsOwnerOnly keeps the record beside the endpoint record under the
// same permissions; it names the machine's checkout and coordinator.
func TestConfigFileIsOwnerOnly(t *testing.T) {
	if os.PathSeparator == 92 {
		t.Skip("POSIX permission bits do not apply on Windows")
	}
	state := t.TempDir()
	if err := SaveConfig(state, Config{Directory: "/checkout"}); err != nil {
		t.Fatalf("SaveConfig = %v", err)
	}
	info, err := os.Stat(filepath.Join(state, ConfigFileName))
	if err != nil {
		t.Fatalf("stat = %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("mode = %v, want 0600", mode)
	}
}

// TestResolvePrecedence pins the rule the whole feature rests on: a flag wins, an
// absent flag falls back to the record, and only a real change is written back.
func TestResolvePrecedence(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		flag    string
		stored  string
		want    string
		changed bool
	}{
		{"flag on an unconfigured machine", "/from-flag", "", "/from-flag", true},
		{"flag overrides a different record", "/from-flag", "/stored", "/from-flag", true},
		{"flag equal to the record writes nothing", "/same", "/same", "/same", false},
		{"no flag reuses the record", "", "/stored", "/stored", false},
		{"no flag and no record stays empty", "", "", "", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			value, changed := resolveString(testCase.flag, testCase.stored)
			if value != testCase.want || changed != testCase.changed {
				t.Fatalf("resolveString(%q, %q) = (%q, %v), want (%q, %v)",
					testCase.flag, testCase.stored, value, changed, testCase.want, testCase.changed)
			}
		})
	}
}

// TestResolveIntPrecedence applies the same rule to a port, where zero is the
// "not supplied" value on both sides.
func TestResolveIntPrecedence(t *testing.T) {
	if value, changed := resolveInt(0, 3080); value != 3080 || changed {
		t.Fatalf("resolveInt(0, 3080) = (%d, %v), want (3080, false)", value, changed)
	}
	if value, changed := resolveInt(3099, 3080); value != 3099 || !changed {
		t.Fatalf("resolveInt(3099, 3080) = (%d, %v), want (3099, true)", value, changed)
	}
	if value, changed := resolveInt(0, 0); value != 0 || changed {
		t.Fatalf("resolveInt(0, 0) = (%d, %v), want (0, false)", value, changed)
	}
}

// TestResolveListPrecedence keeps a repeatable flag whole: a supplied list
// replaces the record, an empty one reuses it, and an identical one is not a
// change.
func TestResolveListPrecedence(t *testing.T) {
	stored := []string{"--prefix", "one"}
	if value, changed := resolveList(nil, stored); changed || len(value) != 2 {
		t.Fatalf("empty flag = (%v, %v), want the record and false", value, changed)
	}
	if value, changed := resolveList([]string{"--prefix", "one"}, stored); changed || len(value) != 2 {
		t.Fatalf("identical flag = (%v, %v), want false", value, changed)
	}
	value, changed := resolveList([]string{"--other"}, stored)
	if !changed || len(value) != 1 || value[0] != "--other" {
		t.Fatalf("different flag = (%v, %v), want the flag and true", value, changed)
	}
}

// TestRequireValueRefusesAnUnsuppliedRequirement keeps the product rule that a
// missing path fails explicitly. Persistence must not soften it into a guess.
func TestRequireValueRefusesAnUnsuppliedRequirement(t *testing.T) {
	if err := requireValue(""); err == nil || err.Error() != "p2p.invalid_arguments" {
		t.Fatalf("requireValue(\"\") = %v, want p2p.invalid_arguments", err)
	}
	if err := requireValue("/checkout"); err != nil {
		t.Fatalf("requireValue(a value) = %v, want nil", err)
	}
}

// TestConfigCarriesNoSecretFields is a structural guarantee, not a spot check:
// the persisted JSON must never gain a password, token, or key field, because the
// OS credential provider owns those and a plaintext copy here would defeat it.
func TestConfigCarriesNoSecretFields(t *testing.T) {
	state := t.TempDir()
	if err := SaveConfig(state, Config{
		Directory: "/checkout",
		Pnpm:      "/bin/pnpm",
		Service:   "svc-1",
		Origin:    "https://coordinator.example",
		PinnedKey: "/etc/dshker/pinned.key",
	}); err != nil {
		t.Fatalf("SaveConfig = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(state, ConfigFileName))
	if err != nil {
		t.Fatalf("read = %v", err)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		t.Fatalf("stored file is not an object: %s", data)
	}
	for name := range fields {
		switch strings.ToLower(name) {
		case "password", "token", "secret", "sessiontoken", "privatekey", "key":
			t.Fatalf("configuration carries a secret field %q", name)
		}
	}
	// The pinned key is referenced by path; the bytes stay in the file it names.
	if !bytes.Contains(data, []byte("/etc/dshker/pinned.key")) {
		t.Fatalf("pinned key path was not persisted: %s", data)
	}
}

// TestConfigCommandShowsAndClears covers the operator's only window into what was
// remembered, including that clearing an unconfigured machine is not an error.
func TestConfigCommandShowsAndClears(t *testing.T) {
	state := t.TempDir()
	if err := SaveConfig(state, Config{Directory: "/checkout", Service: "svc-1"}); err != nil {
		t.Fatalf("SaveConfig = %v", err)
	}
	var stdout, stderr bytes.Buffer
	if code := runConfig([]string{"--state", state}, &stdout, &stderr); code != 0 {
		t.Fatalf("config = %d, stderr %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "/checkout") || !strings.Contains(stdout.String(), "svc-1") {
		t.Fatalf("config output = %s, want the stored values", stdout.String())
	}

	stdout.Reset()
	if code := runConfig([]string{"--state", state, "--clear"}, &stdout, &stderr); code != 0 {
		t.Fatalf("config --clear = %d, stderr %s", code, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(state, ConfigFileName)); !os.IsNotExist(err) {
		t.Fatalf("configuration still present after --clear: %v", err)
	}
	// Clearing twice is idempotent: nothing to forget is not a failure.
	if code := runConfig([]string{"--state", state, "--clear"}, &stdout, &stderr); code != 0 {
		t.Fatalf("second --clear = %d, stderr %s", code, stderr.String())
	}
}
