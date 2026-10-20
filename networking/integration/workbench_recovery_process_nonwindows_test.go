//go:build live && !windows

package integration

import "errors"

func recoveryHoldExactProcess(pid, parent int, executable string) (recoveryExactProcess, error) {
	return nil, errors.New("test.exact_process_crash_requires_windows")
}
