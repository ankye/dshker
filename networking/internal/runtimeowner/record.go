package runtimeowner

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/ankye/dshker/networking/internal/protocol"
)

const (
	ProtocolVersion = 1
	ownerDirectory  = "runtime-owner"
	recordFileName  = "owner.json"
	maxRecordBytes  = 64 * 1024
)

// Config binds one authority to the core's explicitly supplied roots. Empty
// optional roots mean unconfigured, never the state root or a home default.
type Config struct {
	Executable  string `json:"executable"`
	StateRoot   string `json:"stateRoot"`
	DataRoot    string `json:"dataRoot"`
	CatalogRoot string `json:"catalogRoot"`
	RootsPath   string `json:"rootsPath"`
}

type homeContext struct {
	DSHHomePresent     bool   `json:"dshHomePresent"`
	HomePresent        bool   `json:"homePresent"`
	UserProfilePresent bool   `json:"userProfilePresent"`
	Digest             string `json:"digest"`
}

type processIdentity struct {
	PID      int    `json:"pid"`
	Creation string `json:"creation"`
}

// This contains no child URL, account credential, or inherited environment.
// Token authenticates only the private same-user local endpoint.
type ownerRecord struct {
	Version         int             `json:"version"`
	Config          Config          `json:"config"`
	ExecutableHash  string          `json:"executableHash"`
	RootsHash       string          `json:"rootsHash"`
	Home            homeContext     `json:"home"`
	Instance        string          `json:"instance"`
	Token           string          `json:"token"`
	Socket          string          `json:"socket"`
	SocketDirectory string          `json:"socketDirectory"`
	Process         processIdentity `json:"process"`
}

func configRecord(config Config) (ownerRecord, error) {
	return configRecordWithEnvironment(config, os.Environ())
}

func configRecordWithEnvironment(config Config, environment []string) (ownerRecord, error) {
	for _, item := range []struct {
		path                *string
		directory, required bool
	}{
		{&config.StateRoot, true, true}, {&config.Executable, false, true},
		{&config.DataRoot, true, false}, {&config.CatalogRoot, true, false}, {&config.RootsPath, false, false},
	} {
		if *item.path == "" && !item.required {
			continue
		}
		resolved, err := normalizeExplicitPath(*item.path, item.directory)
		if err != nil {
			return ownerRecord{}, ErrOwnerConfiguration
		}
		*item.path = resolved
	}
	executableHash, err := hashFile(config.Executable)
	if err != nil {
		return ownerRecord{}, ErrOwnerConfiguration
	}
	var rootsHash string
	if config.RootsPath != "" {
		rootsHash, err = hashFile(config.RootsPath)
		if err != nil {
			return ownerRecord{}, ErrOwnerConfiguration
		}
	}
	return ownerRecord{Version: ProtocolVersion, Config: config, ExecutableHash: executableHash, RootsHash: rootsHash, Home: homeFromEnvironment(environment)}, nil
}

func inheritedHome() homeContext { return homeFromEnvironment(os.Environ()) }

func homeFromEnvironment(environment []string) homeContext {
	digest := sha256.New()
	var present [3]bool
	for index, key := range []string{"DSH_HOME", "HOME", "USERPROFILE"} {
		var value string
		var exists bool
		for _, entry := range environment {
			name, candidate, found := strings.Cut(entry, "=")
			if found && (name == key || (runtime.GOOS == "windows" && strings.EqualFold(name, key))) {
				value, exists = candidate, true
			}
		}
		present[index] = exists
		io.WriteString(digest, key)
		digest.Write([]byte{0})
		if exists {
			digest.Write([]byte{1})
		} else {
			digest.Write([]byte{0})
		}
		io.WriteString(digest, value)
		digest.Write([]byte{0})
	}
	return homeContext{present[0], present[1], present[2], hex.EncodeToString(digest.Sum(nil))}
}

func normalizeExplicitPath(path string, directory bool) (string, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || (directory && filepath.Dir(path) == path) {
		return "", ErrOwnerConfiguration
	}
	// A system prefix alias (/tmp -> /private/tmp, or Windows long spelling)
	// is normalized. The explicitly selected final object may not be a link.
	info, err := os.Lstat(path)
	if err != nil || finalLink(info) || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return "", ErrOwnerConfiguration
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", ErrOwnerConfiguration
	}
	return resolved, nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func randomHex(bytes int) (string, error) {
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return "", ErrOwnerUnavailable
	}
	return hex.EncodeToString(raw), nil
}

func privateDirectory(path string) error {
	if err := createPrivateDirectory(path); err == nil {
		return checkPrivatePath(path, true)
	} else if !errors.Is(err, os.ErrExist) {
		return ErrOwnerRecordInvalid
	}
	return checkPrivatePath(path, true)
}

func readRecord(path string) (ownerRecord, error) {
	file, err := openRecordFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ownerRecord{}, os.ErrNotExist
		}
		return ownerRecord{}, ErrOwnerRecordInvalid
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxRecordBytes+1))
	var record ownerRecord
	if err != nil || len(raw) > maxRecordBytes || protocol.DecodeExact(raw, &record) != nil {
		return ownerRecord{}, ErrOwnerRecordInvalid
	}
	if record.Version != ProtocolVersion {
		return ownerRecord{}, ErrOwnerProtocol
	}
	if !hexValue(record.Instance, 32) || !hexValue(record.Token, 64) || !hexValue(record.ExecutableHash, 64) || !hexValue(record.Home.Digest, 64) || (record.RootsHash != "" && !hexValue(record.RootsHash, 64)) || record.Socket == "" || record.Process.PID < 0 || (record.Process.PID == 0) != (record.Process.Creation == "") {
		return ownerRecord{}, ErrOwnerRecordInvalid
	}
	if record.Process.PID > 0 && !validRecordedProcess(record.Process) {
		return ownerRecord{}, ErrOwnerRecordInvalid
	}
	return record, nil
}

func hexValue(value string, length int) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(value) == length && len(decoded)*2 == length
}

func sameConfiguration(record, expected ownerRecord) bool {
	return record.Config == expected.Config && record.ExecutableHash == expected.ExecutableHash && record.RootsHash == expected.RootsHash && record.Home == expected.Home
}

type recordOperationError struct {
	code  error
	stage string
	cause error
}

func (failure *recordOperationError) Error() string {
	var errno syscall.Errno
	if errors.As(failure.cause, &errno) {
		return fmt.Sprintf("%s: record %s errno=%d", failure.code, failure.stage, uint32(errno))
	}
	return fmt.Sprintf("%s: record %s errno=unknown", failure.code, failure.stage)
}

func (failure *recordOperationError) Unwrap() []error {
	if failure.cause == nil {
		return []error{failure.code}
	}
	return []error{failure.code, failure.cause}
}

func recordFailure(stage string, cause error) error {
	code := ErrOwnerRecordInvalid
	if errors.Is(cause, ErrOwnerProtocol) {
		code = ErrOwnerProtocol
	}
	return &recordOperationError{code: code, stage: stage, cause: cause}
}

func writeRecord(path string, record ownerRecord) error {
	return writePrivateDocument(path, record)
}

func writePrivateDocument(path string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > maxRecordBytes {
		return recordFailure("encode", err)
	}
	suffix, err := randomHex(8)
	if err != nil {
		return err
	}
	temporary := path + "." + suffix + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return recordFailure("open-temp", err)
	}
	defer os.Remove(temporary)
	if err := secureCreatedPath(temporary, false); err != nil {
		file.Close()
		return recordFailure("secure-acl", err)
	}
	_, writeErr := file.Write(encoded)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return recordFailure("write", writeErr)
	}
	if syncErr != nil {
		return recordFailure("sync", syncErr)
	}
	if closeErr != nil {
		return recordFailure("close", closeErr)
	}
	if err := publishRecordFile(temporary, path); err != nil {
		return recordFailure("rename", err)
	}
	if err := syncRecordDirectory(filepath.Dir(path)); err != nil {
		return recordFailure("directory-sync", err)
	}
	return nil
}

func removeOwnedRecord(path string, expected ownerRecord) error {
	current, err := readRecord(path)
	if err != nil || current != expected {
		return ErrOwnerIdentityMismatch
	}
	if os.Remove(path) != nil {
		return ErrOwnerRecordInvalid
	}
	return syncRecordDirectory(filepath.Dir(path))
}
