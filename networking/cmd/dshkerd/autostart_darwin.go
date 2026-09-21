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
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func launchdServiceName() string {
	return fmt.Sprintf("gui/%d/%s", os.Getuid(), autostartLabel)
}

// loadedLaunchdTarget checks launchd's live job in addition to the plist. A
// safe in-process disable deliberately leaves its current job loaded while
// removing the plist; enabling it again must verify that live job is ours.
func loadedLaunchdTarget() (autostartTarget, bool, error) {
	binary, err := exec.LookPath("launchctl")
	if err != nil {
		return autostartTarget{}, false, errors.New("p2p.autostart_unavailable")
	}
	output, err := exec.Command(binary, "print", launchdServiceName()).CombinedOutput()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 113 {
			return autostartTarget{}, false, nil // launchd: service does not exist.
		}
		return autostartTarget{}, false, errors.New("p2p.autostart_unavailable")
	}
	target, err := parseLoadedLaunchdTarget(string(output))
	if err != nil {
		return autostartTarget{}, false, err
	}
	return target, true, nil
}

func parseLoadedLaunchdTarget(output string) (autostartTarget, error) {
	lines := strings.Split(output, "\n")
	var program string
	var arguments []string
	for index := 0; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		if strings.HasPrefix(line, "program = ") {
			if program != "" {
				return autostartTarget{}, errors.New("p2p.autostart_conflict")
			}
			program = strings.TrimPrefix(line, "program = ")
		}
		if line == "arguments = {" {
			if arguments != nil {
				return autostartTarget{}, errors.New("p2p.autostart_conflict")
			}
			arguments = make([]string, 0, 4)
			for index++; index < len(lines) && strings.TrimSpace(lines[index]) != "}"; index++ {
				arguments = append(arguments, strings.TrimSpace(lines[index]))
			}
		}
	}
	if len(arguments) != 4 || arguments[0] == "" || arguments[0] != program ||
		arguments[1] != "serve" || arguments[2] != "--state" || !filepath.IsAbs(arguments[3]) {
		return autostartTarget{}, errors.New("p2p.autostart_conflict")
	}
	return autostartTarget{executable: arguments[0], state: arguments[3]}, nil
}

// registeredAutostartTarget reads the actual launchd command, not just the
// plist's presence. An unfamiliar or malformed registration is a conflict:
// neither the desktop nor a CLI command may overwrite or delete it blindly.
func registeredAutostartTarget() (autostartTarget, bool, error) {
	path, err := agentPath()
	if err != nil {
		return autostartTarget{}, false, err
	}
	if info, statErr := os.Lstat(path); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return autostartTarget{}, false, errors.New("p2p.autostart_conflict")
		}
	} else if !os.IsNotExist(statErr) {
		return autostartTarget{}, false, errors.New("p2p.autostart_unavailable")
	}
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		// A safe in-process disable removes the plist but leaves the current
		// job loaded. It still owns the global launchd label until bootout.
		return loadedLaunchdTarget()
	}
	if err != nil {
		return autostartTarget{}, false, errors.New("p2p.autostart_unavailable")
	}
	defer file.Close()
	target, parseErr := parseLaunchAgentTarget(file)
	return target, parseErr == nil, parseErr
}

func parseLaunchAgentTarget(reader io.Reader) (autostartTarget, error) {
	decoder := xml.NewDecoder(reader)
	var key string
	var target autostartTarget
	found := false
	for {
		token, decodeErr := decoder.Token()
		if decodeErr == io.EOF {
			break
		}
		if decodeErr != nil {
			return autostartTarget{}, errors.New("p2p.autostart_conflict")
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if start.Name.Local == "key" {
			if decoder.DecodeElement(&key, &start) != nil {
				return autostartTarget{}, errors.New("p2p.autostart_conflict")
			}
			continue
		}
		if key == "ProgramArguments" {
			if start.Name.Local != "array" || found {
				return autostartTarget{}, errors.New("p2p.autostart_conflict")
			}
			var arguments struct {
				Values []string `xml:"string"`
			}
			if decoder.DecodeElement(&arguments, &start) != nil || len(arguments.Values) != 4 ||
				arguments.Values[1] != "serve" || arguments.Values[2] != "--state" {
				return autostartTarget{}, errors.New("p2p.autostart_conflict")
			}
			target = autostartTarget{executable: arguments.Values[0], state: arguments.Values[3]}
			found = true
			key = ""
		}
	}
	if !found || target.executable == "" || target.state == "" {
		return autostartTarget{}, errors.New("p2p.autostart_conflict")
	}
	return target, nil
}

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
	loaded, active, err := loadedLaunchdTarget()
	if err != nil {
		return err
	}
	if active && (loaded.executable != executable || loaded.state != state) {
		return errors.New("p2p.autostart_conflict")
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
	created := false
	if info, statErr := os.Lstat(path); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("p2p.autostart_conflict")
		}
		file, err := os.Open(path)
		if err != nil {
			return errors.New("p2p.autostart_unavailable")
		}
		target, parseErr := parseLaunchAgentTarget(file)
		file.Close()
		if parseErr != nil || target.executable != executable || target.state != state {
			return errors.New("p2p.autostart_conflict")
		}
	} else if os.IsNotExist(statErr) {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return errors.New("p2p.autostart_unavailable")
		}
		written, writeErr := file.Write([]byte(document))
		closeErr := file.Close()
		if writeErr != nil || written != len(document) || closeErr != nil {
			_ = os.Remove(path)
			return errors.New("p2p.autostart_unavailable")
		}
		created = true
	} else {
		return errors.New("p2p.autostart_unavailable")
	}
	// A plist on disk without an admitted launchd job is not a working startup
	// registration. Refuse and remove our write when loading fails.
	binary, lookErr := exec.LookPath("launchctl")
	if lookErr != nil {
		if created {
			_ = os.Remove(path)
		}
		return errors.New("p2p.autostart_unavailable")
	}
	var command *exec.Cmd
	if active {
		command = exec.Command(binary, "enable", launchdServiceName())
	} else {
		command = exec.Command(binary, "load", "-w", path)
	}
	if command.Run() != nil {
		if created {
			_ = os.Remove(path)
		}
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

// removeAutostart unloads the agent and deletes it.
func removeAutostart() error {
	path, err := agentPath()
	if err != nil {
		return err
	}
	if info, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return errors.New("p2p.autostart_unavailable")
	} else if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("p2p.autostart_conflict")
	}
	binary, lookErr := exec.LookPath("launchctl")
	if lookErr != nil || exec.Command(binary, "unload", "-w", path).Run() != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if err := os.Remove(path); err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

// removeAutostartPreservingProcess removes future launchd starts without
// booting out the currently running headless owner. The desktop explicitly
// requests handoff after it has received the disable response. A missing
// launchctl is a refusal here, never a silent file-only disable.
func removeAutostartPreservingProcess() error {
	path, err := agentPath()
	if err != nil {
		return err
	}
	if info, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return errors.New("p2p.autostart_unavailable")
	} else if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("p2p.autostart_conflict")
	}
	binary, err := exec.LookPath("launchctl")
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if err := exec.Command(binary, "disable", launchdServiceName()).Run(); err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if err := os.Remove(path); err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

// retireDisabledAutostart clears the live launchd job after the headless core
// has relinquished its state lock. The plist is already absent, so this never
// unregisters an enabled service. bootout is started as a separate process:
// launchd may signal this very core, and waiting for self-exit would deadlock.
func retireDisabledAutostart(state string) error {
	status, err := autostartStatus()
	if err != nil || status.Installed {
		return err
	}
	loaded, active, err := loadedLaunchdTarget()
	if err != nil || !active {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if loaded.executable != executable || loaded.state != state {
		return errors.New("p2p.autostart_conflict")
	}
	binary, err := exec.LookPath("launchctl")
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	command := exec.Command(binary, "bootout", launchdServiceName())
	if err := command.Start(); err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	_ = command.Process.Release()
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
