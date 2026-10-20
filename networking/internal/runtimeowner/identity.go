package runtimeowner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

// Identity is safe diagnostic metadata, not the endpoint authentication record.
// Creation is the OS process birth identity: Windows FILETIME decimal, or Darwin
// start seconds:microseconds. It is not a runtime PID or a launch timestamp.
type Identity struct {
	Version          int    `json:"version"`
	Instance         string `json:"instance"`
	PID              int    `json:"pid"`
	Creation         string `json:"creation"`
	ExecutableSHA256 string `json:"executableSha256"`
	RootsSHA256      string `json:"rootsSha256"`
	Config           Config `json:"config"`
}

func publicIdentity(record ownerRecord) Identity {
	return Identity{record.Version, record.Instance, record.Process.PID, record.Process.Creation, record.ExecutableHash, record.RootsHash, record.Config}
}

// Identity returns the metadata verified against the authenticated owner hello.
// It is a snapshot; later operations still contact that owner, never this cache.
func (client *Client) Identity() Identity { return publicIdentity(client.record) }

// InspectIdentity reads one explicitly configured private record and verifies
// its exact known OS process. It exposes no socket, token or environment value.
// It is not reattachment admission and does not compare the inspecting process's
// DSH_HOME: only Open/Run authenticate and admit that inherited context.
func InspectIdentity(config Config) (Identity, error) {
	expected, err := configRecord(config)
	if err != nil {
		return Identity{}, err
	}
	directory := filepath.Join(expected.Config.StateRoot, ownerDirectory)
	if err := checkPrivatePath(directory, true); err != nil {
		return Identity{}, ErrOwnerRecordInvalid
	}
	record, err := readRecord(filepath.Join(directory, recordFileName))
	if err != nil {
		return Identity{}, err
	}
	if record.Config != expected.Config || record.ExecutableHash != expected.ExecutableHash || record.RootsHash != expected.RootsHash {
		return Identity{}, ErrOwnerIdentityMismatch
	}
	actual, err := processIdentityAt(record.Process.PID)
	if err != nil || actual != record.Process {
		return Identity{}, ErrOwnerUnavailable
	}
	return publicIdentity(record), nil
}

// InspectIdentityForEnvironment verifies the exact captured launch environment
// without mutating this process's globals or exposing those environment values.
func InspectIdentityForEnvironment(config Config, environment []string) (Identity, error) {
	expected, err := configRecordWithEnvironment(config, environment)
	if err != nil {
		return Identity{}, err
	}
	record, err := existingRecord(expected)
	if err != nil {
		return Identity{}, err
	}
	actual, err := processIdentityAt(record.Process.PID)
	if err != nil || actual != record.Process {
		return Identity{}, ErrOwnerUnavailable
	}
	return publicIdentity(record), nil
}

func existingRecord(expected ownerRecord) (ownerRecord, error) {
	directory := filepath.Join(expected.Config.StateRoot, ownerDirectory)
	if checkPrivatePath(directory, true) != nil {
		return ownerRecord{}, ErrOwnerUnavailable
	}
	record, err := readRecord(filepath.Join(directory, recordFileName))
	if errors.Is(err, os.ErrNotExist) {
		return ownerRecord{}, ErrOwnerUnavailable
	}
	if err != nil {
		return ownerRecord{}, err
	}
	if !sameConfiguration(record, expected) {
		return ownerRecord{}, ErrOwnerIdentityMismatch
	}
	if err := validateOwnerEndpoint(record); err != nil {
		return ownerRecord{}, err
	}
	return record, nil
}

// AttachExisting is an existing-authority client, not a recovery/start helper.
// An explicit captured environment and prior identity are both required; this
// operation has no directory creation, record replacement, spawn or Open path.
func AttachExisting(ctx context.Context, config Config, environment []string, expected Identity) (*Client, error) {
	wanted, err := configRecordWithEnvironment(config, environment)
	if err != nil {
		return nil, err
	}
	record, err := existingRecord(wanted)
	if err != nil {
		return nil, err
	}
	if publicIdentity(record) != expected {
		return nil, ErrOwnerIdentityMismatch
	}
	return connectOwner(ctx, record)
}
