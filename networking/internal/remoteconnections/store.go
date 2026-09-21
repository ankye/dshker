package remoteconnections

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Store reads and replaces the one catalog document the core owns below the
// Settings root.
type Store struct {
	filePath string
}

// Open binds a store to the one accepted file name. The path must be absolute and
// named exactly FileName, so a caller cannot point the core at an arbitrary
// document.
func Open(filePath string) (*Store, error) {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Base(filePath) != FileName {
		return nil, ErrPersistenceFailed
	}
	return &Store{filePath: filePath}, nil
}

// FilePath reports the document this store owns.
func (store *Store) FilePath() string { return store.filePath }

// Load reads the catalog, publishing an empty one when it does not exist yet.
//
// The shell did the same: the remote page is an invitation before it is a
// document, and a missing file is first use rather than a failure. A document
// that exists and cannot be understood is still refused.
func (store *Store) Load() (Record, error) {
	if err := store.assertParent(); err != nil {
		return Record{}, err
	}
	if err := store.assertNotSymlink(); err != nil {
		return Record{}, err
	}
	info, err := os.Lstat(store.filePath)
	if errors.Is(err, os.ErrNotExist) {
		empty := EmptyRecord()
		if err := store.Save(empty); err != nil {
			return Record{}, err
		}
		return empty, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxRecordBytes {
		return Record{}, ErrPersistenceFailed
	}
	raw, err := os.ReadFile(store.filePath)
	if err != nil {
		return Record{}, ErrPersistenceFailed
	}
	return Parse(raw)
}

// Save validates one record, publishes it atomically and proves the published
// bytes by reading them back.
func (store *Store) Save(record Record) error {
	if _, err := Parse(mustMarshal(record)); err != nil {
		return err
	}
	if err := store.assertParent(); err != nil {
		return err
	}
	if err := store.assertNotSymlink(); err != nil {
		return err
	}
	encoded, err := marshalIndentNoEscape(record)
	if err != nil {
		return ErrPersistenceFailed
	}
	if err := store.publish(append(encoded, '\n')); err != nil {
		return err
	}
	readback, err := os.ReadFile(store.filePath)
	if err != nil {
		return fmt.Errorf("%w: the remote connection catalog readback is unavailable.", ErrPersistenceFailed)
	}
	persisted, err := Parse(readback)
	if err != nil {
		return fmt.Errorf("%w: the remote connection catalog readback differs from the committed record.", ErrPersistenceFailed)
	}
	if !bytes.Equal(mustMarshal(persisted), mustMarshal(record)) {
		return fmt.Errorf("%w: the remote connection catalog readback differs from the committed record.", ErrPersistenceFailed)
	}
	return nil
}

// Create publishes one new definition. A display name that differs only in case
// from an existing one is refused, because the page presents names, not ids.
func (store *Store) Create(displayName string, host string, port int, user string, keyPath ...string) ([]Computer, error) {
	sshKeyPath := optionalKeyPath(keyPath)
	if err := assertRequest(displayName, host, port, user, sshKeyPath); err != nil {
		return nil, err
	}
	current, err := store.Load()
	if err != nil {
		return nil, err
	}
	normalized := displayName
	for _, existing := range current.Connections {
		if strings.EqualFold(existing.DisplayName, normalized) {
			return nil, fmt.Errorf("%w: a remote computer with this display name already exists.", ErrExists)
		}
	}
	identity, err := newConnectionID()
	if err != nil {
		return nil, ErrPersistenceFailed
	}
	next := current
	next.Connections = append(append([]Computer{}, current.Connections...), Computer{
		ConnectionID: identity,
		DisplayName:  normalized,
		Host:         host,
		Port:         port,
		User:         user,
		SSHKeyPath:   sshKeyPath,
	})
	if err := store.Save(next); err != nil {
		return nil, err
	}
	return next.Connections, nil
}

// Update replaces one definition whose revision the caller prepared against.
func (store *Store) Update(connectionID string, displayName string, host string, port int, user string, args ...string) ([]Computer, error) {
	sshKeyPath, expectedRevision, argsErr := updateArguments(args)
	if argsErr != nil {
		return nil, argsErr
	}
	if err := AssertConnectionID(connectionID); err != nil {
		return nil, err
	}
	if err := assertRequest(displayName, host, port, user, sshKeyPath); err != nil {
		return nil, err
	}
	current, err := store.Load()
	if err != nil {
		return nil, err
	}
	index := -1
	for position, existing := range current.Connections {
		if existing.ConnectionID == connectionID {
			index = position
			break
		}
	}
	if index < 0 {
		return nil, fmt.Errorf("%w: the remote computer was not found.", ErrNotFound)
	}
	if ConfigRevision(current.Connections[index]) != expectedRevision {
		return nil, fmt.Errorf("%w: the remote computer configuration changed.", ErrConfigConflict)
	}
	for position, existing := range current.Connections {
		if position != index && strings.EqualFold(existing.DisplayName, displayName) {
			return nil, fmt.Errorf("%w: a remote computer with this display name already exists.", ErrExists)
		}
	}
	next := current
	next.Connections = append([]Computer{}, current.Connections...)
	next.Connections[index] = Computer{
		ConnectionID: connectionID,
		DisplayName:  displayName,
		Host:         host,
		Port:         port,
		User:         user,
		SSHKeyPath:   sshKeyPath,
	}
	if err := store.Save(next); err != nil {
		return nil, err
	}
	return next.Connections, nil
}

func optionalKeyPath(value []string) string {
	if len(value) == 0 {
		return ""
	}
	return value[0]
}

func updateArguments(value []string) (string, string, error) {
	if len(value) == 1 {
		return "", value[0], nil
	}
	if len(value) == 2 {
		return value[0], value[1], nil
	}
	return "", "", fmt.Errorf("%w: update arguments are invalid.", ErrInvalidRequest)
}

// Remove deletes one definition.
func (store *Store) Remove(connectionID string) ([]Computer, error) {
	if err := AssertConnectionID(connectionID); err != nil {
		return nil, err
	}
	current, err := store.Load()
	if err != nil {
		return nil, err
	}
	kept := make([]Computer, 0, len(current.Connections))
	found := false
	for _, existing := range current.Connections {
		if existing.ConnectionID == connectionID {
			found = true
			continue
		}
		kept = append(kept, existing)
	}
	if !found {
		return nil, fmt.Errorf("%w: the remote computer was not found.", ErrNotFound)
	}
	next := current
	next.Connections = kept
	if err := store.Save(next); err != nil {
		return nil, err
	}
	return next.Connections, nil
}

func (store *Store) assertParent() error {
	info, err := os.Lstat(filepath.Dir(store.filePath))
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: the remote connection settings directory is unavailable.", ErrPersistenceFailed)
	}
	return nil
}

func (store *Store) assertNotSymlink() error {
	info, err := os.Lstat(store.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("%w: the remote connection catalog could not be inspected.", ErrPersistenceFailed)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: the remote connection catalog must not be a symbolic link.", ErrPersistenceFailed)
	}
	return nil
}

// publish replaces the document through a private temporary file in the same
// directory, so a reader sees the previous complete record or the next one.
func (store *Store) publish(encoded []byte) error {
	directory := filepath.Dir(store.filePath)
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(store.filePath)+".*.tmp")
	if err != nil {
		return fmt.Errorf("%w: the remote connection catalog could not be written.", ErrPersistenceFailed)
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("%w: the remote connection catalog could not be written.", ErrPersistenceFailed)
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("%w: the remote connection catalog could not be written.", ErrPersistenceFailed)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("%w: the remote connection catalog could not be written.", ErrPersistenceFailed)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("%w: the remote connection catalog could not be written.", ErrPersistenceFailed)
	}
	if err := os.Rename(name, store.filePath); err != nil {
		return fmt.Errorf("%w: the remote connection catalog could not be published.", ErrPersistenceFailed)
	}
	syncDirectory(directory)
	return nil
}

func syncDirectory(directory string) {
	handle, err := os.Open(directory)
	if err != nil {
		return
	}
	defer func() { _ = handle.Close() }()
	_ = handle.Sync()
}

func marshalIndentNoEscape(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}
