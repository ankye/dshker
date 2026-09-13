package installcatalog

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Store owns one catalog file. The core's dispatcher serializes its operations,
// so a concurrent save cannot interleave with the read it replaces.
type Store struct {
	filePath string
}

// Open binds a store to the one file name the catalog is written to. The path
// must be absolute and named exactly CatalogFileName, so a caller cannot point
// the core at an arbitrary document.
func Open(filePath string) (*Store, error) {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Base(filePath) != CatalogFileName {
		return nil, ErrPersistenceFailed
	}
	return &Store{filePath: filePath}, nil
}

// Load reads and validates the persisted catalog. A missing document never
// becomes an empty one: the caller decides what first run means.
func (store *Store) Load() (Catalog, error) {
	info, err := os.Lstat(store.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Catalog{}, ErrMissingCatalog
		}
		return Catalog{}, ErrPersistenceFailed
	}
	// A symlinked catalog could redirect the write this store performs.
	if !info.Mode().IsRegular() || info.Size() > MaxCatalogBytes {
		return Catalog{}, ErrInvalid
	}
	raw, err := os.ReadFile(store.filePath)
	if err != nil {
		return Catalog{}, ErrPersistenceFailed
	}
	return Parse(raw)
}

// Save validates one catalog, publishes it atomically, and proves the published
// bytes by reading them back.
func (store *Store) Save(catalog Catalog) error {
	if err := AssertCatalog(catalog); err != nil {
		return err
	}
	if err := store.assertNotSymlink(); err != nil {
		return err
	}
	encoded, err := encode(catalog)
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

func (store *Store) assertNotSymlink() error {
	info, err := os.Lstat(store.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return ErrPersistenceFailed
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return ErrSymbolicLink
	}
	return nil
}

// publish writes a complete document beside the catalog and only then makes it
// visible, so a crash leaves either the old catalog or the new one.
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
	if os.PathSeparator == '\\' {
		return
	}
	handle, err := os.Open(directory)
	if err != nil {
		return
	}
	_ = handle.Sync()
	_ = handle.Close()
}

// encode serializes the catalog exactly as the shell did: two-space indentation,
// no HTML escaping, and a trailing newline.
func encode(catalog Catalog) ([]byte, error) {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(catalog); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
