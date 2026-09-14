// Package remoteconnections owns the persisted remote-computer catalog: the
// stable definitions the Launcher's remote page lists, independently of any live
// SSH generation.
//
// It is the Go half of electron/main/remote/catalog.ts. The rules are ported
// rather than reinterpreted: the same document, the same strict exact-key
// decoding at every depth, the same value grammars, the same case-folded display
// name uniqueness, the same sha256 configuration revision, the same atomic
// replace with a proven readback, and the same create-on-first-read.
package remoteconnections

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Format, Version and FileName identify the document. The core accepts exactly
// this one file name below the Settings root, so the location is not a caller's
// choice.
const (
	Format   = "dsh-launcher.remote-connections"
	Version  = 1
	FileName = "remote-connections.json"
	// MaxRecordBytes bounds the document this process reads into memory.
	MaxRecordBytes = 256 * 1024
	// MaxConnections bounds the catalog, matching the display-name space the page
	// can present.
	MaxConnections = 256

	MaxDisplayNameBytes = 64
	MaxHostBytes        = 253
	MaxUserBytes        = 64
)

// Refusal codes the shell already maps. They cross the private channel
// unchanged, which is why the protocol declares the remote family.
var (
	ErrInvalidRequest     = errors.New("remote.invalid_request")
	ErrInvalidRecord      = errors.New("remote.invalid_record")
	ErrUnsupportedVersion = errors.New("remote.unsupported_version")
	ErrPersistenceFailed  = errors.New("remote.persistence_failed")
	ErrNotFound           = errors.New("remote.connection_not_found")
	ErrExists             = errors.New("remote.connection_exists")
	ErrConfigConflict     = errors.New("remote.config_conflict")
)

// Computer is one persisted remote account.
type Computer struct {
	ConnectionID string `json:"connectionId"`
	DisplayName  string `json:"displayName"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	User         string `json:"user"`
}

// Record is the whole document.
type Record struct {
	Format      string     `json:"format"`
	Version     int        `json:"version"`
	Connections []Computer `json:"connections"`
}

// EmptyRecord is the document a first read publishes.
func EmptyRecord() Record {
	return Record{Format: Format, Version: Version, Connections: []Computer{}}
}

// The shell expressed "no leading hyphen" with a lookahead; the leading classes
// below already forbid it, and Go's RE2 has no lookahead and needs none here.
var (
	connectionIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	hostPattern         = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$`)
	userPattern         = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)
	controlPattern      = regexp.MustCompile("[\\x00-\\x1f\\x7f]")
)

// AssertComputer refuses anything that is not one storable definition.
func AssertComputer(computer Computer) error {
	return assertRequest(computer.DisplayName, computer.Host, computer.Port, computer.User)
}

func assertRequest(displayName string, host string, port int, user string) error {
	if displayName != strings.TrimSpace(displayName) || len(displayName) < 1 ||
		len(displayName) > MaxDisplayNameBytes || controlPattern.MatchString(displayName) {
		return fmt.Errorf("%w: the display name is invalid.", ErrInvalidRequest)
	}
	if len(host) > MaxHostBytes || !hostPattern.MatchString(host) {
		return fmt.Errorf("%w: the SSH host is invalid.", ErrInvalidRequest)
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("%w: the SSH port is invalid.", ErrInvalidRequest)
	}
	if len(user) > MaxUserBytes || !userPattern.MatchString(user) {
		return fmt.Errorf("%w: the SSH user is invalid.", ErrInvalidRequest)
	}
	return nil
}

// AssertConnectionID reports whether one identity is a version 4 uuid.
func AssertConnectionID(connectionID string) error {
	if !connectionIDPattern.MatchString(connectionID) {
		return fmt.Errorf("%w: the remote connection identity is invalid.", ErrInvalidRequest)
	}
	return nil
}

// ConfigRevision is the sha256 of the definition, exactly as the shell computed
// it: JSON.stringify with no spaces over the five ordered fields. The shell uses
// it to refuse an edit that was prepared against another version of the record,
// so this string is a contract, not an implementation detail.
func ConfigRevision(computer Computer) string {
	fields := []any{computer.ConnectionID, computer.DisplayName, computer.Host, computer.Port, computer.User}
	encoded, err := json.Marshal(fields)
	if err != nil {
		encoded = []byte("[]")
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// newConnectionID returns one version 4 uuid, which is the identity grammar the
// document and the shell share.
func newConnectionID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

// Parse strictly parses one catalog document.
func Parse(data []byte) (Record, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return Record{}, fmt.Errorf("%w: the remote connection record must be an object.", ErrInvalidRecord)
	}
	if !exactKeys(fields, "format", "version", "connections") {
		return Record{}, fmt.Errorf("%w: the remote connection record fields are invalid.", ErrInvalidRecord)
	}
	var format string
	var version int
	var entries []json.RawMessage
	if json.Unmarshal(fields["format"], &format) != nil || format != Format {
		return Record{}, fmt.Errorf("%w: the remote connection catalog format is invalid.", ErrInvalidRecord)
	}
	if json.Unmarshal(fields["version"], &version) != nil || version != Version {
		return Record{}, fmt.Errorf("%w: the remote connection catalog version is unsupported.", ErrUnsupportedVersion)
	}
	if json.Unmarshal(fields["connections"], &entries) != nil {
		return Record{}, fmt.Errorf("%w: the remote connection catalog entries are invalid.", ErrInvalidRecord)
	}
	if len(entries) > MaxConnections {
		return Record{}, fmt.Errorf("%w: the remote connection catalog is too large.", ErrInvalidRecord)
	}
	connections := make([]Computer, 0, len(entries))
	ids := map[string]bool{}
	names := map[string]bool{}
	for _, entry := range entries {
		var entryFields map[string]json.RawMessage
		if json.Unmarshal(entry, &entryFields) != nil || entryFields == nil ||
			!exactKeys(entryFields, "connectionId", "displayName", "host", "port", "user") {
			return Record{}, fmt.Errorf("%w: the remote computer entry fields are invalid.", ErrInvalidRecord)
		}
		var computer Computer
		if json.Unmarshal(entry, &computer) != nil {
			return Record{}, fmt.Errorf("%w: the remote computer entry values are invalid.", ErrInvalidRecord)
		}
		if AssertConnectionID(computer.ConnectionID) != nil || AssertComputer(computer) != nil {
			return Record{}, fmt.Errorf("%w: the remote computer entry values are invalid.", ErrInvalidRecord)
		}
		folded := strings.ToLower(computer.DisplayName)
		if ids[computer.ConnectionID] || names[folded] {
			return Record{}, fmt.Errorf("%w: the remote computer identities must be unique.", ErrInvalidRecord)
		}
		ids[computer.ConnectionID] = true
		names[folded] = true
		connections = append(connections, computer)
	}
	return Record{Format: Format, Version: Version, Connections: connections}, nil
}

// Encode renders the document the shell wrote: two-space indentation, a trailing
// newline, and no HTML escaping.
func Encode(record Record) ([]byte, error) {
	if _, err := Parse(mustMarshal(record)); err != nil {
		return nil, err
	}
	encoded, err := marshalIndentNoEscape(record)
	if err != nil {
		return nil, fmt.Errorf("%w: the remote connection catalog could not be encoded.", ErrPersistenceFailed)
	}
	return append(encoded, '\n'), nil
}

// FilePathInside returns the one catalog path below a Settings root.
func FilePathInside(settingsRoot string) string {
	return filepath.Join(settingsRoot, "dsh-launcher", FileName)
}

func exactKeys(fields map[string]json.RawMessage, expected ...string) bool {
	if len(fields) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func mustMarshal(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("null")
	}
	return encoded
}
