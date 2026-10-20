//go:build live && !windows

package integration

import (
	"errors"
	"os/exec"
)

func recoveryPauseNativePrerequisites() error {
	return errors.New("test.program_pause_requires_windows_debug_api")
}

func recoveryPauseTickMilliseconds() (uint64, error) {
	return 0, recoveryPauseNativePrerequisites()
}

func recoveryPauseSelf(string) (recoveryProcessProof, error) {
	return recoveryProcessProof{}, recoveryPauseNativePrerequisites()
}

func recoveryPauseOpenExpected(recoveryProcessProof, string) (recoveryExactProcess, error) {
	return nil, recoveryPauseNativePrerequisites()
}

func recoveryPauseIndependentCommand(*exec.Cmd) {}

func recoveryPauseConfirmUnpaused(recoveryExactProcess) error {
	return recoveryPauseNativePrerequisites()
}

func recoveryPauseHelper(string, string) error { return recoveryPauseNativePrerequisites() }
