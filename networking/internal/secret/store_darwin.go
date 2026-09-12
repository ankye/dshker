//go:build darwin

package secret

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// The build is CGO_ENABLED=0, so the Keychain is reached through the system
// security tool with every secret on stdin, never in argv. Writing requires
// -w with no value so security reads stdin; it asks for the value twice, so
// each write sends the value as two lines, and -U makes an add overwrite an
// existing item.
//
// The interactive -w reader accepts at most 128 bytes of text per item and
// silently truncates anything longer, so a value is base64-encoded (the
// reader is a text channel and mangles raw binary) and stored as numbered
// chunks under <key>#00, <key>#01, … with a header item under <key> naming
// the chunk count. The header is written last: a Get that finds no header
// reports ErrMissing even if a crashed Set left chunks behind. Chunk payloads
// stay well under the reader limit.
const (
	keychainService = "dshkerd"
	keychainTool    = "security"
	chunkSize       = 96
	maxChunks       = 4096
)

// Open returns the macOS Keychain provider. The data root is not used on
// macOS: the Keychain keeps the items.
func Open(dataRoot string) (Store, error) {
	return keychainStore{}, nil
}

type keychainStore struct{}

func (keychainStore) Get(key string) ([]byte, error) {
	header, err := keychainRead(key)
	if err != nil {
		return nil, err
	}
	count, err := strconv.Atoi(string(header))
	if err != nil || count < 1 || count > maxChunks {
		return nil, ErrRead
	}
	encoded := make([]byte, 0, count*chunkSize)
	for index := 0; index < count; index++ {
		chunk, err := keychainRead(chunkKey(key, index))
		if err != nil {
			return nil, err
		}
		if index < count-1 && len(chunk) != chunkSize {
			return nil, ErrRead
		}
		encoded = append(encoded, chunk...)
	}
	value, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		return nil, ErrRead
	}
	return value, nil
}

func (keychainStore) Set(key string, value []byte) error {
	encoded := []byte(base64.StdEncoding.EncodeToString(value))
	count := (len(encoded) + chunkSize - 1) / chunkSize
	if count < 1 {
		count = 1
	}
	if count > maxChunks {
		return fmt.Errorf("%w: value too large", ErrWrite)
	}
	for index := 0; index < count; index++ {
		end := (index + 1) * chunkSize
		if end > len(encoded) {
			end = len(encoded)
		}
		if err := keychainWrite(chunkKey(key, index), encoded[index*chunkSize:end]); err != nil {
			return err
		}
	}
	// The header commits the value: until it exists, Get reports the key as
	// missing and a later Set overwrites every chunk it names.
	return keychainWrite(key, []byte(strconv.Itoa(count)))
}

func (keychainStore) Delete(key string) error {
	header, err := keychainRead(key)
	if err == nil {
		if count, conv := strconv.Atoi(string(header)); conv == nil && count >= 0 && count <= maxChunks {
			for index := 0; index < count; index++ {
				_ = keychainDelete(chunkKey(key, index))
			}
		}
	} else if !errors.Is(err, ErrMissing) {
		return err
	}
	return keychainDelete(key)
}

func chunkKey(key string, index int) string {
	return key + "#" + strconv.Itoa(index)
}

func keychainRead(key string) ([]byte, error) {
	output, err := exec.Command(keychainTool, "find-generic-password", "-a", key, "-s", keychainService, "-w").Output()
	if err != nil {
		if notFound(err) {
			return nil, ErrMissing
		}
		return nil, ErrRead
	}
	return bytes.TrimSuffix(output, []byte("\n")), nil
}

func keychainWrite(key string, value []byte) error {
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

func keychainDelete(key string) error {
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
