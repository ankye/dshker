//go:build darwin

package secret

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// The build is CGO_ENABLED=0, so the Keychain is reached through the system
// security tool with the secret on stdin, never in argv. The read flag is -w,
// and writing requires the flag -w with no value so security reads stdin; it
// asks for the value twice, so Set writes it as two lines, and -U makes an add
// overwrite an existing item.
const (
	keychainService = "dshkerd"
	keychainTool    = "security"
)

// Open returns the macOS Keychain provider. The data root is not used on
// macOS: the Keychain keeps the items.
func Open(dataRoot string) (Store, error) {
	return keychainStore{}, nil
}

type keychainStore struct{}

func (keychainStore) Get(key string) ([]byte, error) {
	output, err := exec.Command(keychainTool, "find-generic-password", "-a", key, "-s", keychainService, "-w").Output()
	if err != nil {
		if notFound(err) {
			return nil, ErrMissing
		}
		return nil, ErrRead
	}
	return bytes.TrimSuffix(output, []byte("\n")), nil
}

func (keychainStore) Set(key string, value []byte) error {
	input := make([]byte, 0, 2*len(value)+2)
	input = append(input, value...)
	input = append(input, '\n')
	input = append(input, value...)
	input = append(input, '\n')
	command := exec.Command(keychainTool, "add-generic-password", "-a", key, "-s", keychainService, "-U", "-w")
	command.Stdin = bytes.NewReader(input)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", ErrWrite, strings.TrimSpace(string(output)))
	}
	return nil
}

func (keychainStore) Delete(key string) error {
	err := exec.Command(keychainTool, "delete-generic-password", "-a", key, "-s", keychainService).Run()
	if err != nil && !notFound(err) {
		return ErrDelete
	}
	return nil
}

// notFound reports the security tool's "the specified item could not be found"
// case without parsing locale-dependent text: errSecItemNotFound is exit 44.
func notFound(err error) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == 44
}
