//go:build linux

package secret

import (
	"bytes"
	"os/exec"
)

// Open returns the Linux Secret Service provider.
//
// A machine without the libsecret tool has no reachable provider, because the
// core carries no D-Bus client of its own, so this refuses rather than storing
// anything privately. The refusal is the same code the shell and the CLI already
// map for a platform with no provider.
func Open(dataRoot string) (Store, error) {
	if _, err := exec.LookPath(secretServiceTool); err != nil {
		return nil, ErrUnavailable
	}
	return secretServiceStore{run: runSecretServiceTool}, nil
}

// runSecretServiceTool runs one invocation with the secret on stdin and the two
// streams kept apart, so a read can never be confused with a diagnostic.
func runSecretServiceTool(stdin string, arguments ...string) (string, string, error) {
	command := exec.Command(secretServiceTool, arguments...)
	if stdin != "" {
		command.Stdin = bytes.NewReader([]byte(stdin))
	}
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	return stdout.String(), stderr.String(), err
}
