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
)

// runKeyPath is the current user's autorun key.
const runKeyPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

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
	binary, err := exec.LookPath("reg.exe")
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	output, runErr := exec.Command(binary, "delete", runKeyPath, "/v", autostartLabel, "/f").CombinedOutput()
	if runErr != nil {
		if strings.Contains(strings.ToLower(string(output)), "unable to find") {
			return nil
		}
		return errors.New("p2p.autostart_unavailable")
	}
	return nil
}

// autostartStatus queries the run key.
func autostartStatus() (AutostartState, error) {
	state := AutostartState{Mechanism: "registry-run-key", Path: runKeyPath + `\` + autostartLabel}
	binary, err := exec.LookPath("reg.exe")
	if err != nil {
		return AutostartState{}, errors.New("p2p.autostart_unavailable")
	}
	output, runErr := exec.Command(binary, "query", runKeyPath, "/v", autostartLabel).CombinedOutput()
	if runErr != nil {
		// A missing value is the ordinary "not installed" answer, not a failure.
		state.Installed = false
		return state, nil
	}
	state.Installed = strings.Contains(string(output), autostartLabel)
	return state, nil
}
