//go:build darwin

package main

// launchd is macOS's own supervisor, so the registration is a LaunchAgent plist
// in the user's own Library. A user agent, not a system daemon: a daemon would
// need root and would put the core outside the user whose Keychain holds its
// device key, which is the store `serve` opens.
//
// `RunAtLoad` plus `KeepAlive` is what makes this a real headless registration —
// launchd starts the core when the agent is loaded at boot and restarts it if it
// exits, without anyone logging in to a desktop session.

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// agentPath returns this user's LaunchAgent plist for the core.
func agentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("p2p.autostart_unavailable")
	}
	return filepath.Join(home, "Library", "LaunchAgents", autostartLabel+".plist"), nil
}

// installAutostart writes the agent and loads it.
//
// The program arguments carry only `serve --state <dir>`: every other choice is
// read from the persisted configuration, so changing the checkout or the stores
// later does not require rewriting this registration.
func installAutostart(executable string, state string) error {
	path, err := agentPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	document := strings.Join([]string{
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0">`,
		`<dict>`,
		`	<key>Label</key>`,
		`	<string>` + plistEscape(autostartLabel) + `</string>`,
		`	<key>ProgramArguments</key>`,
		`	<array>`,
		`		<string>` + plistEscape(executable) + `</string>`,
		`		<string>serve</string>`,
		`		<string>--state</string>`,
		`		<string>` + plistEscape(state) + `</string>`,
		`	</array>`,
		`	<key>RunAtLoad</key>`,
		`	<true/>`,
		`	<key>KeepAlive</key>`,
		`	<true/>`,
		`	<key>StandardOutPath</key>`,
		`	<string>` + plistEscape(filepath.Join(state, "autostart.out.log")) + `</string>`,
		`	<key>StandardErrorPath</key>`,
		`	<string>` + plistEscape(filepath.Join(state, "autostart.err.log")) + `</string>`,
		`</dict>`,
		`</plist>`,
		``,
	}, "\n")
	if err := os.WriteFile(path, []byte(document), 0o644); err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	// Loading is best-effort on purpose: the plist is the registration and boot
	// reads it regardless, so a machine with launchctl unavailable (a build
	// container, a restricted session) still ends up correctly registered rather
	// than failing after the file was already written.
	if binary, lookErr := exec.LookPath("launchctl"); lookErr == nil {
		_ = exec.Command(binary, "load", "-w", path).Run()
	}
	return nil
}

// removeAutostart unloads the agent and deletes it.
func removeAutostart() error {
	path, err := agentPath()
	if err != nil {
		return err
	}
	if binary, lookErr := exec.LookPath("launchctl"); lookErr == nil {
		_ = exec.Command(binary, "unload", "-w", path).Run()
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

// autostartStatus reports whether the agent is present.
func autostartStatus() (AutostartState, error) {
	path, err := agentPath()
	if err != nil {
		return AutostartState{}, err
	}
	_, statErr := os.Stat(path)
	if statErr != nil && !os.IsNotExist(statErr) {
		return AutostartState{}, errors.New("p2p.autostart_unavailable")
	}
	return AutostartState{
		Installed: statErr == nil,
		Mechanism: "launchd",
		Path:      path,
	}, nil
}

// plistEscape keeps a path with XML-significant characters from breaking the
// document. A directory may legitimately contain an ampersand.
func plistEscape(value string) string {
	replaced := strings.ReplaceAll(value, "&", "&amp;")
	replaced = strings.ReplaceAll(replaced, "<", "&lt;")
	return strings.ReplaceAll(replaced, ">", "&gt;")
}
