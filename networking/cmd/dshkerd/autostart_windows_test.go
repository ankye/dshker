//go:build windows

package main

import "testing"

func cleanupAutostartFixture(executable string, state string) {
	target, installed, err := registeredAutostartTarget()
	if err == nil && installed && target.executable == executable && target.state == state {
		_ = removeAutostart()
	}
}

func TestParseWindowsRunCommandKeepsUnicodePaths(t *testing.T) {
	command := `"C:\用户 文件\dshkerd.exe" serve --state "C:\用户 文件\state"`
	target, err := parseWindowsRunCommand(command)
	if err != nil || target.executable != `C:\用户 文件\dshkerd.exe` || target.state != `C:\用户 文件\state` {
		t.Fatalf("target = %+v, %v", target, err)
	}
}

func TestParseWindowsRunCommandRejectsForeignValues(t *testing.T) {
	for name, command := range map[string]string{
		"unquoted":       `C:\dshkerd.exe serve --state "C:\state"`,
		"wrong verb":     `"C:\dshkerd.exe" other --state "C:\state"`,
		"extra argument": `"C:\dshkerd.exe" serve --state "C:\state" --data C:\data`,
		"empty state":    `"C:\dshkerd.exe" serve --state ""`,
		"empty binary":   `"" serve --state "C:\state"`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseWindowsRunCommand(command); err == nil || err.Error() != "p2p.autostart_conflict" {
				t.Fatalf("parse = %v, want conflict", err)
			}
		})
	}
}
