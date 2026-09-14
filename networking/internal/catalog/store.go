package catalog

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

const (
	recordFile = "p2p-devices.json"
	markerFile = "p2p-enabled.json"
)

// Store owns the catalog files under one main-owned directory. Every
// operation is serialized, so a concurrent commit cannot interleave with the
// read it is based on.
type Store struct {
	directory string
	mu        sync.Mutex
}

// Open binds a store to an existing directory. The directory is the
// main-owned settings location; a missing or non-directory path is refused
// before any file is touched.
func Open(directory string) (*Store, error) {
	if directory == "" || !filepath.IsAbs(directory) {
		return nil, ErrSettingsRoot
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSettingsRoot
	}
	return &Store{directory: directory}, nil
}

// Inspect reports the catalog, or a nil snapshot when the user has never
// enabled it. Exactly one of the two files present is a corrupt state, never
// an implicit reset.
func (store *Store) Inspect() (*Snapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	recordThere, err := exists(store.path(recordFile))
	if err != nil {
		return nil, err
	}
	markerThere, err := exists(store.path(markerFile))
	if err != nil {
		return nil, err
	}
	if !recordThere && !markerThere {
		return nil, nil
	}
	if !recordThere || !markerThere {
		return nil, ErrIncomplete
	}
	snapshot, err := store.read()
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// Enable creates the first, empty catalog and its marker. It refuses when
// either file already exists so a second enable cannot erase the first.
func (store *Store) Enable() (Snapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, name := range []string{recordFile, markerFile} {
		there, err := exists(store.path(name))
		if err != nil {
			return Snapshot{}, err
		}
		if there {
			return Snapshot{}, ErrExists
		}
	}
	identifier := make([]byte, 6)
	if _, err := rand.Read(identifier); err != nil {
		return Snapshot{}, ErrWriteFailed
	}
	catalogID := hex.EncodeToString(identifier)
	record := Record{
		Format:              recordFormat,
		Version:             1,
		CatalogID:           catalogID,
		Services:            []Service{},
		Computers:           []Computer{},
		ForgottenServiceIDs: []string{},
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return Snapshot{}, ErrWriteFailed
	}
	marker, err := json.Marshal(struct {
		Version   int    `json:"version"`
		CatalogID string `json:"catalogId"`
	}{Version: 1, CatalogID: catalogID})
	if err != nil {
		return Snapshot{}, ErrWriteFailed
	}
	if err := publish(store.path(recordFile), encoded, false); err != nil {
		return Snapshot{}, err
	}
	if err := publish(store.path(markerFile), marker, false); err != nil {
		return Snapshot{}, err
	}
	return store.read()
}

// Commit replaces the catalog when the caller's revision still matches and
// the transition keeps identity continuity. An unchanged record is a no-op,
// so a redundant commit does not churn the file or the revision.
func (store *Store) Commit(expectedRevision string, next Record) (Snapshot, error) {
	encoded, err := json.Marshal(next)
	if err != nil {
		return Snapshot{}, ErrInvalid
	}
	validated, err := Parse(encoded)
	if err != nil {
		return Snapshot{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	previous, err := store.read()
	if err != nil {
		return Snapshot{}, err
	}
	if previous.Revision != expectedRevision || previous.Record.CatalogID != validated.CatalogID {
		return Snapshot{}, ErrConflict
	}
	if err := AssertTransition(previous.Record, validated); err != nil {
		return Snapshot{}, err
	}
	current, err := json.Marshal(previous.Record)
	if err != nil {
		return Snapshot{}, ErrWriteFailed
	}
	canonical, err := json.Marshal(validated)
	if err != nil {
		return Snapshot{}, ErrWriteFailed
	}
	if string(current) == string(canonical) {
		return previous, nil
	}
	if err := publish(store.path(recordFile), canonical, true); err != nil {
		return Snapshot{}, err
	}
	return store.read()
}

// RemoveService forgets one service locally. It reads tolerantly so a record
// that no longer passes strict validation (an expired certificate, say)
// cannot block deleting the coordinator, but the file it writes is always
// re-validated so the app can still read it.
func (store *Store) RemoveService(serviceID string) (Snapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	raw, err := readFile(store.path(recordFile))
	if err != nil {
		return Snapshot{}, err
	}
	record, err := Parse(raw)
	if err != nil {
		if record, err = parseTolerant(raw); err != nil {
			return Snapshot{}, err
		}
	}
	for _, forgotten := range record.ForgottenServiceIDs {
		if forgotten == serviceID {
			return Snapshot{}, ErrTrustRestore
		}
	}
	found := false
	services := make([]Service, 0, len(record.Services))
	for _, service := range record.Services {
		if service.ServiceID == serviceID {
			found = true
			continue
		}
		services = append(services, service)
	}
	if !found {
		return Snapshot{}, ErrServiceNotFound
	}
	computers := make([]Computer, 0, len(record.Computers))
	for _, computer := range record.Computers {
		if computer.ServiceID != serviceID {
			computers = append(computers, computer)
		}
	}
	next := Record{
		Format:              recordFormat,
		Version:             1,
		CatalogID:           record.CatalogID,
		Services:            services,
		Computers:           computers,
		ForgottenServiceIDs: append(append([]string{}, record.ForgottenServiceIDs...), serviceID),
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return Snapshot{}, ErrWriteFailed
	}
	if _, err := Parse(encoded); err != nil {
		return Snapshot{}, err
	}
	if err := publish(store.path(recordFile), encoded, true); err != nil {
		return Snapshot{}, err
	}
	return store.read()
}

func (store *Store) path(name string) string {
	return filepath.Join(store.directory, name)
}

// read returns the catalog with the revision the shell computes: the sha256
// of the file bytes, with the marker checked against the record.
func (store *Store) read() (Snapshot, error) {
	raw, err := readFile(store.path(recordFile))
	if err != nil {
		return Snapshot{}, err
	}
	record, err := Parse(raw)
	if err != nil {
		return Snapshot{}, err
	}
	markerRaw, err := readFile(store.path(markerFile))
	if err != nil {
		return Snapshot{}, err
	}
	var marker struct {
		Version   int    `json:"version"`
		CatalogID string `json:"catalogId"`
	}
	if err := strictJSON(markerRaw, &marker); err != nil {
		return Snapshot{}, ErrInvalid
	}
	if marker.Version != 1 || marker.CatalogID != record.CatalogID {
		return Snapshot{}, ErrInvalid
	}
	digest := sha256.Sum256(raw)
	return Snapshot{Revision: hex.EncodeToString(digest[:]), Record: record}, nil
}

// parseTolerant keeps only the fields removal needs from a record that failed
// strict validation.
func parseTolerant(raw []byte) (Record, error) {
	var record Record
	if err := strictJSON(raw, &record); err != nil {
		return Record{}, ErrInvalid
	}
	if record.Format != recordFormat || record.Version != 1 || record.Services == nil || record.Computers == nil || record.ForgottenServiceIDs == nil {
		return Record{}, ErrInvalid
	}
	return record, nil
}

func exists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, ErrUnavailable
}

func readFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, ErrUnavailable
	}
	if !info.Mode().IsRegular() || info.Size() > MaxRecordBytes {
		return nil, ErrInvalid
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, ErrUnavailable
	}
	return raw, nil
}

// publish writes a complete file and only then makes it visible: a link for a
// first write so an existing record is never overwritten, a rename for a
// replacement. Windows cannot rename onto an existing file, so the old record
// is moved aside and restored if the swap fails.
func publish(path string, data []byte, replace bool) error {
	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		return ErrWriteFailed
	}
	temporary := path + "." + hex.EncodeToString(suffix) + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrWriteFailed
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(temporary)
		return ErrWriteFailed
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temporary)
		return ErrWriteFailed
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return ErrWriteFailed
	}
	if !replace {
		if err := os.Link(temporary, path); err != nil {
			os.Remove(temporary)
			return ErrWriteFailed
		}
		os.Remove(temporary)
		return nil
	}
	if err := os.Rename(temporary, path); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		os.Remove(temporary)
		return ErrWriteFailed
	}
	backup := path + "." + hex.EncodeToString(suffix) + ".bak"
	if err := os.Rename(path, backup); err != nil {
		os.Remove(temporary)
		return ErrWriteFailed
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Rename(backup, path)
		os.Remove(temporary)
		return ErrWriteFailed
	}
	os.Remove(backup)
	return nil
}
