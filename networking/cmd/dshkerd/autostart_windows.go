//go:build windows

package main

// On Windows the registration is the current user's `Run` key.
//
// A scheduled task with a boot trigger is the other candidate and it does start
// without a logged-in user, but registering one requires either `schtasks` with
// elevation or the task-scheduler COM API. The run key stays inside HKCU, needs no
// elevation, and matches the rule that the core must not write a registration
// outside the current user's scope without explicit elevation. The tradeoff is
// real and recorded: this fires at user logon rather than at machine boot.
//
// `reg.exe` is used rather than a registry package so the core keeps no extra
// dependency for a three-value operation, and every failure is reported as a
// typed refusal instead of a partially written key.

import (
	"errors"
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// runKeyPath is the current user's autorun key.
const runKeyPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

const runKeyRegistryPath = `Software\Microsoft\Windows\CurrentVersion\Run`

// registeredAutostartTarget reads the value through the native registry API so
// Unicode paths and localized reg.exe output cannot change ownership checks.
func registeredAutostartTarget() (autostartTarget, bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyRegistryPath, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return autostartTarget{}, false, nil
	}
	if err != nil {
		return autostartTarget{}, false, errors.New("p2p.autostart_unavailable")
	}
	defer key.Close()
	command, valueType, err := key.GetStringValue(autostartLabel)
	if errors.Is(err, registry.ErrNotExist) {
		return autostartTarget{}, false, nil
	}
	if err != nil {
		return autostartTarget{}, false, errors.New("p2p.autostart_unavailable")
	}
	if valueType != registry.SZ {
		return autostartTarget{}, false, errors.New("p2p.autostart_conflict")
	}
	target, err := parseWindowsRunCommand(command)
	return target, err == nil, err
}

func parseWindowsRunCommand(command string) (autostartTarget, error) {
	// The registration writer emits exactly this four-argument spelling. A
	// differently quoted or extended command is not this installation's value.
	if !strings.HasPrefix(command, `"`) {
		return autostartTarget{}, errors.New("p2p.autostart_conflict")
	}
	endExecutable := strings.Index(command[1:], `"`)
	if endExecutable < 0 {
		return autostartTarget{}, errors.New("p2p.autostart_conflict")
	}
	endExecutable++
	const middle = ` serve --state "`
	if !strings.HasPrefix(command[endExecutable+1:], middle) || !strings.HasSuffix(command, `"`) {
		return autostartTarget{}, errors.New("p2p.autostart_conflict")
	}
	state := command[endExecutable+1+len(middle) : len(command)-1]
	if endExecutable == 1 || state == "" || strings.Contains(state, `"`) {
		return autostartTarget{}, errors.New("p2p.autostart_conflict")
	}
	return autostartTarget{executable: command[1:endExecutable], state: state}, nil
}

// installAutostart writes the run-key value.
//
// The command line carries only `serve --state <dir>`; every other choice comes
// from the persisted configuration, so this registration does not go stale when
// the operator reconfigures the machine.
func installAutostart(executable string, state string) error {
	binary, err := exec.LookPath("reg.exe")
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	// Quoted so a path containing spaces stays one argument at logon.
	command := `"` + executable + `" serve --state "` + state + `"`
	output, runErr := exec.Command(binary, "add", runKeyPath, "/v", autostartLabel,
		"/t", "REG_SZ", "/d", command, "/f").CombinedOutput()
	if runErr != nil {
		_ = output
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

// removeAutostart deletes the run-key value. A value that is already absent is
// not a failure, so disabling twice is idempotent.
func removeAutostart() error {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyRegistryPath, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	defer key.Close()
	if err := key.DeleteValue(autostartLabel); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

func removeAutostartPreservingProcess() error { return removeAutostart() }

func retireDisabledAutostart(string) error { return nil }

// autostartStatus queries the run key.
func autostartStatus() (AutostartState, error) {
	state := AutostartState{Mechanism: "registry-run-key", Path: runKeyPath + `\` + autostartLabel}
	_, installed, err := registeredAutostartTarget()
	if err != nil {
		return AutostartState{}, err
	}
	state.Installed = installed
	return state, nil
}
