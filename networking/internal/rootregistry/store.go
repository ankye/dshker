package rootregistry

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Store owns one registry file. Every operation is serialized by the core's
// dispatcher, so a concurrent save cannot interleave with the read it replaces.
type Store struct {
	filePath      string
	nativeDshHome string
}

// Open binds a store to the one file name the registry is written to. The path
// must be absolute and named exactly RegistryFileName, so a caller cannot point
// the core at an arbitrary document.
func Open(filePath, nativeDshHome string) (*Store, error) {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Base(filePath) != RegistryFileName {
		return nil, ErrPersistenceFailed
	}
	if err := AssertCanonicalRootPath(nativeDshHome); err != nil {
		return nil, err
	}
	return &Store{filePath: filePath, nativeDshHome: nativeDshHome}, nil
}

// Load reads and validates the persisted registry. A missing document never
// becomes a default: the caller decides what first run means.
func (store *Store) Load() (Registry, error) {
	info, err := os.Lstat(store.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Registry{}, ErrMissingRegistry
		}
		return Registry{}, ErrPersistenceFailed
	}
	// A symlinked registry could redirect the write this store performs, so it is
	// refused on the way in as well as on the way out.
	if !info.Mode().IsRegular() || info.Size() > MaxRegistryBytes {
		return Registry{}, ErrInvalid
	}
	raw, err := os.ReadFile(store.filePath)
	if err != nil {
		return Registry{}, ErrPersistenceFailed
	}
	return Parse(raw, store.nativeDshHome)
}

// Save validates one registry, publishes it atomically, and proves the published
// bytes by reading them back.
func (store *Store) Save(registry Registry) error {
	if err := AssertRegistry(registry, store.nativeDshHome); err != nil {
		return err
	}
	if err := store.assertNotSymlink(); err != nil {
		return err
	}
	encoded, err := encode(registry)
	if err != nil {
		return ErrPersistenceFailed
	}
	if err := store.publish(encoded); err != nil {
		return err
	}
	reloaded, err := store.Load()
	if err != nil {
		return ErrPersistenceFailed
	}
	readback, err := encode(reloaded)
	if err != nil || !bytes.Equal(readback, encoded) {
		return ErrPersistenceFailed
	}
	return nil
}

// AssertRegistry verifies registry topology independently of persistence.
func AssertRegistry(registry Registry, nativeDshHome string) error {
	if registry.Format != Format {
		return ErrInvalid
	}
	if registry.Version != Version {
		return ErrUnsupportedVersion
	}
	if err := AssertRootLayout(registry.Roots, nativeDshHome); err != nil {
		return err
	}
	for _, workspace := range registry.Workspaces {
		if err := AssertWorkspaceBinding(workspace, registry.Roots, nativeDshHome); err != nil {
			return err
		}
	}
	return AssertWorkspacesDoNotOverlap(registry.Workspaces)
}

func (store *Store) assertNotSymlink() error {
	info, err := os.Lstat(store.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return ErrPersistenceFailed
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return ErrRootSymbolicLink
	}
	return nil
}

// publish writes a complete document beside the registry and only then makes it
// visible, so a crash leaves either the old registry or the new one.
func (store *Store) publish(encoded []byte) error {
	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		return ErrPersistenceFailed
	}
	directory := filepath.Dir(store.filePath)
	temporary := filepath.Join(directory, "."+filepath.Base(store.filePath)+"."+hex.EncodeToString(suffix)+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrPersistenceFailed
	}
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		os.Remove(temporary)
		return ErrPersistenceFailed
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temporary)
		return ErrPersistenceFailed
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return ErrPersistenceFailed
	}
	if err := os.Rename(temporary, store.filePath); err != nil {
		os.Remove(temporary)
		return ErrPersistenceFailed
	}
	syncDirectory(directory)
	return nil
}

// syncDirectory makes the rename durable. Windows cannot open a directory for
// this, and does not need to.
func syncDirectory(directory string) {
	if windows() {
		return
	}
	handle, err := os.Open(directory)
	if err != nil {
		return
	}
	_ = handle.Sync()
	_ = handle.Close()
}

// encode serializes the registry exactly as the shell did: two-space indentation,
// no HTML escaping, and a trailing newline.
func encode(registry Registry) ([]byte, error) {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(registry); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
