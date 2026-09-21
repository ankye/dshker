//go:build darwin

package main

// Darwin-only registration assertions: they read the launchd plist and the plist
// escaper, which exist only on this platform.

import (
	"os"
	"os/exec"
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
	t.Cleanup(func() {
		// A preserving-process disable intentionally leaves a launchd job
		// loaded. This exact test target is ours; boot it out if a failure
		// occurs between disable and the re-enable assertion below.
		if target, loaded, err := loadedLaunchdTarget(); err == nil && loaded &&
			target.executable == "/opt/dshkerd/dshkerd" && target.state == state {
			_ = exec.Command("launchctl", "bootout", launchdServiceName()).Run()
		}
		if path, err := agentPath(); err == nil {
			_ = os.Remove(path)
		}
	})
	if err := installAutostart("/opt/dshkerd/dshkerd", state); err != nil {
		t.Fatalf("installAutostart = %v", err)
	}
	reported, err := autostartStatus()
	if err != nil || !reported.Installed {
		t.Fatalf("status after install = (%+v, %v), want installed", reported, err)
	}
	target, installed, err := registeredAutostartTarget()
	if err != nil || !installed || target.executable != "/opt/dshkerd/dshkerd" || target.state != state {
		t.Fatalf("registered target = %+v, %v, %v", target, installed, err)
	}
	if err := requireAutostartOwnership("/opt/dshkerd/dshkerd", state); err != nil {
		t.Fatalf("matching registration refused: %v", err)
	}
	if err := requireAutostartOwnership("/other/dshkerd", state); err == nil || err.Error() != "p2p.autostart_conflict" {
		t.Fatalf("foreign executable = %v, want conflict", err)
	}
	if err := requireAutostartOwnership("/opt/dshkerd/dshkerd", t.TempDir()); err == nil || err.Error() != "p2p.autostart_conflict" {
		t.Fatalf("foreign state = %v, want conflict", err)
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
	if err := removeAutostartPreservingProcess(); err != nil {
		t.Fatalf("preserving-process removal: %v", err)
	}
	after, err := autostartStatus()
	if err != nil || after.Installed {
		t.Fatalf("registration remained after safe removal: %+v, %v", after, err)
	}
	if err := retireDisabledAutostart(state); err == nil || err.Error() != "p2p.autostart_conflict" {
		t.Fatalf("foreign loaded job retirement = %v, want conflict", err)
	}
	if err := installAutostart("/opt/dshkerd/dshkerd", state); err != nil {
		t.Fatalf("re-enable an already loaded own job: %v", err)
	}
	if err := removeAutostart(); err != nil {
		t.Fatalf("normal removal after re-enable: %v", err)
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

func TestParseLaunchAgentTargetRejectsMalformedOrExtendedCommand(t *testing.T) {
	for name, document := range map[string]string{
		"missing arguments":   `<plist><dict><key>Label</key><string>com.ankye.dshkerd</string></dict></plist>`,
		"extra argument":      `<plist><dict><key>ProgramArguments</key><array><string>/bin/dshkerd</string><string>serve</string><string>--state</string><string>/state</string><string>--data</string></array></dict></plist>`,
		"wrong command":       `<plist><dict><key>ProgramArguments</key><array><string>/bin/dshkerd</string><string>other</string><string>--state</string><string>/state</string></array></dict></plist>`,
		"duplicate arguments": `<plist><dict><key>ProgramArguments</key><array><string>/bin/dshkerd</string><string>serve</string><string>--state</string><string>/state</string></array><key>ProgramArguments</key><array><string>/bin/other</string><string>serve</string><string>--state</string><string>/state</string></array></dict></plist>`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseLaunchAgentTarget(strings.NewReader(document)); err == nil || err.Error() != "p2p.autostart_conflict" {
				t.Fatalf("parse = %v, want conflict", err)
			}
		})
	}
}

func TestParseLoadedLaunchdTargetRequiresExactServeCommand(t *testing.T) {
	valid := "program = /Applications/DSHKer Launcher.app/Contents/Resources/dshkerd\n" +
		"arguments = {\n/Applications/DSHKer Launcher.app/Contents/Resources/dshkerd\nserve\n--state\n/Users/operator/state\n}\n"
	target, err := parseLoadedLaunchdTarget(valid)
	if err != nil || target.executable != "/Applications/DSHKer Launcher.app/Contents/Resources/dshkerd" || target.state != "/Users/operator/state" {
		t.Fatalf("loaded target = %+v, %v", target, err)
	}
	for name, output := range map[string]string{
		"wrong executable": strings.Replace(valid, "program = /Applications", "program = /Other", 1),
		"extra argument":   strings.Replace(valid, "--state\n", "--state\n--data\n", 1),
		"relative state":   strings.Replace(valid, "/Users/operator/state", "relative/state", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseLoadedLaunchdTarget(output); err == nil || err.Error() != "p2p.autostart_conflict" {
				t.Fatalf("parse loaded target = %v", err)
			}
		})
	}
}

func cleanupAutostartFixture(executable string, state string) {
	target, installed, err := registeredAutostartTarget()
	if err == nil && installed && target.executable == executable && target.state == state {
		_ = removeAutostart()
	}
	// CLI disable intentionally leaves the current launchd job loaded while
	// deleting its plist. The test must not leak that job into the developer's
	// login session, but may only boot out its own exact temporary target.
	target, loaded, err := loadedLaunchdTarget()
	if err == nil && loaded && target.executable == executable && target.state == state {
		_ = exec.Command("launchctl", "bootout", launchdServiceName()).Run()
	}
}
