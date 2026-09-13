// Package installcatalog owns the Launcher's managed Harness installation
// catalog: the externally selected toolchains and the exact Harness revisions
// materialized from them.
//
// The on-disk format, the file name and the refusal codes are the ones
// `electron/main/managed/installation-catalog.ts` already wrote, so a catalog
// either side produced stays readable by the other while ownership moves. The
// rules are ported rather than reinterpreted, including the one that keeps the
// catalog honest about its own remotes: a persisted remote identity must still
// describe its declared URL.
package installcatalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Format and Version identify the persisted document. A different version is
// refused, never migrated or upgraded in place.
const (
	Format  = "dsh-launcher.managed-installation-catalog"
	Version = 3
)

// CatalogFileName is the only file name the catalog is ever written to.
const CatalogFileName = "managed-installation-catalog.json"

// MaxCatalogBytes bounds the document.
const MaxCatalogBytes = 512 * 1024

var (
	ErrInvalid            = errors.New("managed.invalid_record")
	ErrUnsupportedVersion = errors.New("managed.unsupported_version")
	ErrMissingCatalog     = errors.New("managed.missing_registry")
	ErrPersistenceFailed  = errors.New("managed.persistence_failed")
	ErrSymbolicLink       = errors.New("managed.root_symbolic_link")
)

var (
	opaqueIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{2,127}$`)
	commitSha       = regexp.MustCompile(`^[0-9a-f]{40}$`)
	// A reference short name: no refs/ prefix, no traversal, no sequences Git
	// itself refuses, and no segment ending in .lock or a dot.
	referenceUnsafe = regexp.MustCompile("[\\s\\x00-\\x1f~^:?*\\\\\\[]|\\.\\.|@\\{")
)

// GitVersion is one parsed dotted Git release version.
type GitVersion struct {
	Major int    `json:"major"`
	Minor int    `json:"minor"`
	Patch int    `json:"patch"`
	Text  string `json:"text"`
}

// GitFingerprint pins the Git executable file identity.
type GitFingerprint struct {
	Device                 int64 `json:"device"`
	Inode                  int64 `json:"inode"`
	Size                   int64 `json:"size"`
	ModifiedAtMilliseconds int64 `json:"modifiedAtMilliseconds"`
}

// GitExecutable is one registered external Git executable.
type GitExecutable struct {
	RequestedPath string         `json:"requestedPath"`
	CanonicalPath string         `json:"canonicalPath"`
	Fingerprint   GitFingerprint `json:"fingerprint"`
	Version       GitVersion     `json:"version"`
}

// Selection is a selected remote-tracking branch, tag, or exact commit. Exactly
// one value accompanies the kind, and the wire shape carries exactly one.
type Selection struct {
	Kind   string `json:"kind"`
	Branch string `json:"branch,omitempty"`
	Tag    string `json:"tag,omitempty"`
	Commit string `json:"commit,omitempty"`
}

// Installation is one exact managed Harness revision.
type Installation struct {
	InstallationID    string      `json:"installationId"`
	WorkspaceID       string      `json:"workspaceId"`
	ToolchainID       string      `json:"toolchainId"`
	Remote            NamedRemote `json:"remote"`
	Selection         Selection   `json:"selection"`
	Commit            string      `json:"commit"`
	ObservedReference string      `json:"observedReference"`
	ObservedObject    string      `json:"observedObject"`
	TagObject         *string     `json:"tagObject,omitempty"`
}

// ToolchainFingerprint pins one externally selected Node or pnpm executable.
type ToolchainFingerprint struct {
	Device                 int64 `json:"device"`
	Inode                  int64 `json:"inode"`
	Mode                   int64 `json:"mode"`
	Size                   int64 `json:"size"`
	ModifiedAtMilliseconds int64 `json:"modifiedAtMilliseconds"`
	ChangedAtMilliseconds  int64 `json:"changedAtMilliseconds"`
}

// ToolchainVersion is a stable three-component version with no prerelease part.
type ToolchainVersion struct {
	Major int    `json:"major"`
	Minor int    `json:"minor"`
	Patch int    `json:"patch"`
	Text  string `json:"text"`
}

// NodeExecutable is one explicitly selected Node executable.
type NodeExecutable struct {
	RequestedPath string               `json:"requestedPath"`
	CanonicalPath string               `json:"canonicalPath"`
	Fingerprint   ToolchainFingerprint `json:"fingerprint"`
	Version       ToolchainVersion     `json:"version"`
}

// PnpmLauncher is one of the two accepted pnpm launch forms.
type PnpmLauncher struct {
	Kind string          `json:"kind"`
	Node *NodeExecutable `json:"node,omitempty"`
}

// PnpmExecutable is one explicitly selected pnpm entry.
type PnpmExecutable struct {
	RequestedPath string               `json:"requestedPath"`
	CanonicalPath string               `json:"canonicalPath"`
	Fingerprint   ToolchainFingerprint `json:"fingerprint"`
	Launcher      PnpmLauncher         `json:"launcher"`
	Version       ToolchainVersion     `json:"version"`
}

// Toolchain is the toolchain one installation was created with.
type Toolchain struct {
	ToolchainID string         `json:"toolchainId"`
	Git         GitExecutable  `json:"git"`
	Node        NodeExecutable `json:"node"`
	Pnpm        PnpmExecutable `json:"pnpm"`
}

// Catalog is the complete document.
type Catalog struct {
	Format        string         `json:"format"`
	Version       int            `json:"version"`
	Toolchains    []Toolchain    `json:"toolchains"`
	Installations []Installation `json:"installations"`
}

// EmptyCatalog is the exact empty document first run persists.
func EmptyCatalog() Catalog {
	return Catalog{Format: Format, Version: Version, Toolchains: []Toolchain{}, Installations: []Installation{}}
}

// Parse strictly decodes one persisted catalog.
func Parse(raw []byte) (Catalog, error) {
	if len(raw) == 0 || len(raw) > MaxCatalogBytes {
		return Catalog{}, ErrInvalid
	}
	fields, ok := decodeObject(raw)
	if !ok || !exactKeys(fields, "format", "version", "toolchains", "installations") {
		return Catalog{}, ErrInvalid
	}
	var format string
	if json.Unmarshal(fields["format"], &format) != nil || format != Format {
		return Catalog{}, ErrInvalid
	}
	var version int
	if json.Unmarshal(fields["version"], &version) != nil {
		return Catalog{}, ErrInvalid
	}
	if version != Version {
		return Catalog{}, ErrUnsupportedVersion
	}
	toolchains, ok := parseToolchains(fields["toolchains"])
	if !ok {
		return Catalog{}, ErrInvalid
	}
	installations, ok := parseInstallations(fields["installations"])
	if !ok {
		return Catalog{}, ErrInvalid
	}
	catalog := Catalog{Format: Format, Version: Version, Toolchains: toolchains, Installations: installations}
	if err := AssertCatalog(catalog); err != nil {
		return Catalog{}, err
	}
	return catalog, nil
}

// AssertCatalog verifies catalog uniqueness and every nested Git identity.
func AssertCatalog(catalog Catalog) error {
	if catalog.Format != Format || catalog.Version != Version {
		return ErrInvalid
	}
	toolchainIDs := make(map[string]bool, len(catalog.Toolchains))
	for _, toolchain := range catalog.Toolchains {
		if !opaqueID(toolchain.ToolchainID) || toolchainIDs[toolchain.ToolchainID] {
			return ErrInvalid
		}
		toolchainIDs[toolchain.ToolchainID] = true
		if !validGitExecutable(toolchain.Git) || !validNodeExecutable(toolchain.Node) {
			return ErrInvalid
		}
		if !validPnpmExecutable(toolchain.Pnpm) {
			return ErrInvalid
		}
		if toolchain.Pnpm.Launcher.Kind == "node-script" {
			if toolchain.Pnpm.Launcher.Node == nil ||
				!sameNodeRegistration(*toolchain.Pnpm.Launcher.Node, toolchain.Node) {
				return ErrInvalid
			}
		}
	}
	installationIDs := make(map[string]bool, len(catalog.Installations))
	for _, installation := range catalog.Installations {
		if !opaqueID(installation.InstallationID) ||
			!opaqueID(installation.WorkspaceID) ||
			!opaqueID(installation.ToolchainID) ||
			installationIDs[installation.InstallationID] {
			return ErrInvalid
		}
		installationIDs[installation.InstallationID] = true
		if !toolchainIDs[installation.ToolchainID] {
			return ErrInvalid
		}
		if !validRemote(installation.Remote) || !validSelection(installation.Selection) {
			return ErrInvalid
		}
		if !fullCommit(installation.Commit) || !fullCommit(installation.ObservedObject) {
			return ErrInvalid
		}
		if installation.ObservedReference == "" {
			return ErrInvalid
		}
		hasTagObject := installation.TagObject != nil && fullCommit(*installation.TagObject)
		if installation.TagObject != nil && !hasTagObject {
			return ErrInvalid
		}
		if (installation.Selection.Kind == "tag") != hasTagObject {
			return ErrInvalid
		}
	}
	return nil
}

func parseToolchains(raw json.RawMessage) ([]Toolchain, bool) {
	entries, ok := decodeArray(raw)
	if !ok {
		return nil, false
	}
	toolchains := make([]Toolchain, 0, len(entries))
	for _, entry := range entries {
		if !strictToolchain(entry) {
			return nil, false
		}
		var toolchain Toolchain
		if json.Unmarshal(entry, &toolchain) != nil {
			return nil, false
		}
		toolchains = append(toolchains, toolchain)
	}
	return toolchains, true
}

func parseInstallations(raw json.RawMessage) ([]Installation, bool) {
	entries, ok := decodeArray(raw)
	if !ok {
		return nil, false
	}
	installations := make([]Installation, 0, len(entries))
	for _, entry := range entries {
		fields, ok := decodeObject(entry)
		if !ok || !hasRequired(fields, "installationId", "workspaceId", "toolchainId", "remote", "selection", "commit", "observedReference", "observedObject") ||
			!hasOnly(fields, "installationId", "workspaceId", "toolchainId", "remote", "selection", "commit", "observedReference", "observedObject", "tagObject") {
			return nil, false
		}
		if !exactKeysValue(fields["selection"], "kind", "branch") &&
			!exactKeysValue(fields["selection"], "kind", "tag") &&
			!exactKeysValue(fields["selection"], "kind", "commit") {
			return nil, false
		}
		if !strictRemote(fields["remote"]) {
			return nil, false
		}
		var installation Installation
		if json.Unmarshal(entry, &installation) != nil {
			return nil, false
		}
		installations = append(installations, installation)
	}
	return installations, true
}

// strictToolchain and friends check the exact key set of every nested record, so
// a catalog with an unknown field anywhere is refused rather than partially
// understood — the shell's parser did the same at every depth.
func strictToolchain(raw json.RawMessage) bool {
	fields, ok := decodeObject(raw)
	if !ok || !exactKeys(fields, "toolchainId", "git", "node", "pnpm") {
		return false
	}
	return strictGitExecutable(fields["git"]) &&
		strictNodeExecutable(fields["node"]) &&
		strictPnpmExecutable(fields["pnpm"])
}

func strictGitExecutable(raw json.RawMessage) bool {
	fields, ok := decodeObject(raw)
	if !ok || !exactKeys(fields, "requestedPath", "canonicalPath", "fingerprint", "version") {
		return false
	}
	if !exactKeysValue(fields["fingerprint"], "device", "inode", "size", "modifiedAtMilliseconds") {
		return false
	}
	return exactKeysValue(fields["version"], "major", "minor", "patch", "text")
}

func strictToolchainFingerprint(raw json.RawMessage) bool {
	return exactKeysValue(raw, "device", "inode", "mode", "size", "modifiedAtMilliseconds", "changedAtMilliseconds")
}

func strictNodeExecutable(raw json.RawMessage) bool {
	fields, ok := decodeObject(raw)
	if !ok || !exactKeys(fields, "requestedPath", "canonicalPath", "fingerprint", "version") {
		return false
	}
	if !strictToolchainFingerprint(fields["fingerprint"]) {
		return false
	}
	return exactKeysValue(fields["version"], "major", "minor", "patch", "text")
}

func strictPnpmExecutable(raw json.RawMessage) bool {
	fields, ok := decodeObject(raw)
	if !ok || !exactKeys(fields, "requestedPath", "canonicalPath", "fingerprint", "launcher", "version") {
		return false
	}
	if !strictToolchainFingerprint(fields["fingerprint"]) {
		return false
	}
	if !exactKeysValue(fields["version"], "major", "minor", "patch", "text") {
		return false
	}
	launcher, ok := decodeObject(fields["launcher"])
	if !ok {
		return false
	}
	if _, present := launcher["node"]; present {
		return exactKeys(launcher, "kind", "node") && strictNodeExecutable(launcher["node"])
	}
	return exactKeys(launcher, "kind")
}

func strictRemote(raw json.RawMessage) bool {
	fields, ok := decodeObject(raw)
	if !ok || !exactKeys(fields, "name", "source") {
		return false
	}
	source, ok := decodeObject(fields["source"])
	if !ok || !exactKeys(source, "declaredUrl", "identity") {
		return false
	}
	identity, ok := decodeObject(source["identity"])
	if !ok {
		return false
	}
	allowed := []string{"transport", "host", "effectivePort", "repositoryPathKind", "repositoryPath", "display"}
	if _, present := identity["sshUser"]; present {
		allowed = append(allowed, "sshUser")
	}
	return exactKeys(identity, allowed...)
}

func validGitExecutable(value GitExecutable) bool {
	if !normalizedAbsolutePath(value.RequestedPath) || !normalizedAbsolutePath(value.CanonicalPath) {
		return false
	}
	if value.Fingerprint.Device < 0 || value.Fingerprint.Inode < 0 ||
		value.Fingerprint.Size < 0 || value.Fingerprint.ModifiedAtMilliseconds < 0 {
		return false
	}
	return validVersion(value.Version.Major, value.Version.Minor, value.Version.Patch, value.Version.Text)
}

func validNodeExecutable(value NodeExecutable) bool {
	if !normalizedAbsolutePath(value.RequestedPath) || !normalizedAbsolutePath(value.CanonicalPath) {
		return false
	}
	if !validToolchainFingerprint(value.Fingerprint) {
		return false
	}
	return validVersion(value.Version.Major, value.Version.Minor, value.Version.Patch, value.Version.Text)
}

func validPnpmExecutable(value PnpmExecutable) bool {
	if !normalizedAbsolutePath(value.RequestedPath) || !normalizedAbsolutePath(value.CanonicalPath) {
		return false
	}
	if !validToolchainFingerprint(value.Fingerprint) {
		return false
	}
	if !validVersion(value.Version.Major, value.Version.Minor, value.Version.Patch, value.Version.Text) {
		return false
	}
	switch value.Launcher.Kind {
	case "native":
		return value.Launcher.Node == nil
	case "node-script":
		return value.Launcher.Node != nil && validNodeExecutable(*value.Launcher.Node)
	}
	return false
}

func validToolchainFingerprint(value ToolchainFingerprint) bool {
	return value.Device >= 0 && value.Inode >= 0 && value.Mode >= 0 && value.Size >= 0 &&
		value.ModifiedAtMilliseconds >= 0 && value.ChangedAtMilliseconds >= 0
}

func validVersion(major, minor, patch int, text string) bool {
	if major < 0 || minor < 0 || patch < 0 {
		return false
	}
	return text == itoa(major)+"."+itoa(minor)+"."+itoa(patch)
}

func validRemote(value NamedRemote) bool {
	if !remoteNamePattern.MatchString(value.Name) || strings.HasPrefix(value.Name, ".") {
		return false
	}
	parsed, ok := ParseRemoteIdentity(value.Source.DeclaredURL)
	if !ok {
		return false
	}
	identity := value.Source.Identity
	if identity.Display != parsed.Display || !remoteIdentitiesEqual(parsed, identity) {
		return false
	}
	// The persisted identity carries sshUser only when the URL has one.
	return (identity.SSHUser != "") == (parsed.SSHUser != "")
}

func validSelection(value Selection) bool {
	switch value.Kind {
	case "branch":
		return value.Tag == "" && value.Commit == "" && validReferenceShortName(value.Branch)
	case "tag":
		return value.Branch == "" && value.Commit == "" && validReferenceShortName(value.Tag)
	case "commit":
		return value.Branch == "" && value.Tag == "" && fullCommit(value.Commit)
	}
	return false
}

func validReferenceShortName(value string) bool {
	if value == "" || len(value) > 1024 ||
		strings.HasPrefix(value, "refs/") || strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") {
		return false
	}
	if referenceUnsafe.MatchString(value) || strings.Contains(value, "//") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." ||
			strings.HasSuffix(segment, ".lock") || strings.HasSuffix(segment, ".") {
			return false
		}
	}
	return true
}

func fullCommit(value string) bool { return commitSha.MatchString(value) }

func opaqueID(value string) bool { return opaqueIDPattern.MatchString(value) }

func normalizedAbsolutePath(value string) bool {
	if value == "" || strings.ContainsRune(value, 0) {
		return false
	}
	if !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return false
	}
	volume := filepath.VolumeName(value)
	return value != volume+string(os.PathSeparator) && value != string(os.PathSeparator)
}

func sameNodeRegistration(left, right NodeExecutable) bool {
	leftEncoded, leftErr := json.Marshal(left)
	rightEncoded, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftEncoded, rightEncoded)
}

func decodeObject(raw []byte) (map[string]json.RawMessage, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

func decodeArray(raw []byte) ([]json.RawMessage, bool) {
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || entries == nil {
		return nil, false
	}
	return entries, true
}

func exactKeys(fields map[string]json.RawMessage, expected ...string) bool {
	if len(fields) != len(expected) {
		return false
	}
	return hasRequired(fields, expected...)
}

func exactKeysValue(raw json.RawMessage, expected ...string) bool {
	fields, ok := decodeObject(raw)
	if !ok {
		return false
	}
	return exactKeys(fields, expected...)
}

func hasRequired(fields map[string]json.RawMessage, expected ...string) bool {
	for _, key := range expected {
		if _, present := fields[key]; !present {
			return false
		}
	}
	return true
}

func hasOnly(fields map[string]json.RawMessage, allowed ...string) bool {
	for key := range fields {
		found := false
		for _, value := range allowed {
			if key == value {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// itoa avoids pulling fmt in for three small numbers.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
