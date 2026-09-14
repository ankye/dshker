package secret

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// The Secret Service provider, spoken through the libsecret command line tool.
//
// The build is CGO_ENABLED=0, so there is no D-Bus client to talk to the keyring
// directly: `secret-tool` is libsecret's own client, invoked the way the macOS
// provider invokes `security`. A secret travels on stdin for a write and on
// stdout for a read, never in argv, and nothing is written below the data root —
// the keyring owns the items.
//
// The logic lives here without a build tag so its argument order, output parsing
// and failure classification can be tested where secret-tool does not exist;
// store_linux.go is the file that binds it to the tool, and a machine without the
// tool has no provider at all.
const (
	secretServiceTool      = "secret-tool"
	secretServiceSchema    = "dshkerd"
	secretServiceAttribute = "key"
)

// secretServiceRunner runs one tool invocation and returns its streams. It is a
// seam: production wires exec.Command in, tests record what was asked.
type secretServiceRunner func(stdin string, arguments ...string) (string, string, error)

type secretServiceStore struct {
	run secretServiceRunner
}

// Get reads one item back. The tool prints the secret as text, so the value is
// stored base64-encoded — a text channel would otherwise mangle binary key
// material — and the trailing newline the tool may add is trimmed.
func (store secretServiceStore) Get(key string) ([]byte, error) {
	stdout, stderr, err := store.run("", "lookup", secretServiceSchema, secretServiceAttribute, key)
	if err != nil {
		return nil, classifySecretServiceFailure(stderr, err)
	}
	value, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(stdout))
	if decodeErr != nil {
		return nil, ErrRead
	}
	return value, nil
}

// Set stores one item. libsecret replaces an item with the same schema and
// attributes, so a repeated Set overwrites rather than accumulating, and the
// commit is the store itself: a failed write leaves the previous value in place.
func (store secretServiceStore) Set(key string, value []byte) error {
	encoded := base64.StdEncoding.EncodeToString(value)
	_, stderr, err := store.run(encoded, "store", "--label", secretServiceLabel(key), secretServiceSchema, secretServiceAttribute, key)
	if err != nil {
		if classified := classifySecretServiceFailure(stderr, err); errors.Is(classified, ErrUnavailable) {
			return classified
		}
		return fmt.Errorf("%w: %s", ErrWrite, strings.TrimSpace(stderr))
	}
	return nil
}

// Delete removes one item, and deleting an absent key succeeds: the tool reports
// "no such item" as a failure, which is the state the caller asked for.
func (store secretServiceStore) Delete(key string) error {
	_, stderr, err := store.run("", "clear", secretServiceSchema, secretServiceAttribute, key)
	if err != nil {
		if classified := classifySecretServiceFailure(stderr, err); errors.Is(classified, ErrMissing) {
			return nil
		}
		return ErrDelete
	}
	return nil
}

func secretServiceLabel(key string) string {
	return secretServiceSchema + " " + key
}

// exitCoder is the part of a process failure the classifier reads. os/exec's
// ExitError implements it, and a test can supply its own without spawning
// anything.
type exitCoder interface {
	ExitCode() int
}

// classifySecretServiceFailure maps a tool failure onto the package's codes.
// "No such item" is exit status 1 with nothing on either stream; a keyring that
// cannot be reached is a missing provider rather than a damaged item, which
// matters most on a machine with no desktop session and therefore no session
// bus; anything else is a read failure.
func classifySecretServiceFailure(stderr string, err error) error {
	var coder exitCoder
	if errors.As(err, &coder) && coder.ExitCode() == 1 && strings.TrimSpace(stderr) == "" {
		return ErrMissing
	}
	if noSessionBus(stderr) {
		return ErrUnavailable
	}
	return ErrRead
}

// noSessionBus reports the messages libsecret prints when no keyring answers.
// They are matched as text because the tool's exit status is the same for every
// one of them, and the alternative — reporting a write failure for a machine
// that has no provider — sends the operator looking for corruption.
func noSessionBus(stderr string) bool {
	for _, marker := range []string{
		"Cannot autolaunch D-Bus",
		"Failed to open connection",
		"Could not connect",
		"No such file or directory",
	} {
		if strings.Contains(stderr, marker) {
			return true
		}
	}
	return false
}
