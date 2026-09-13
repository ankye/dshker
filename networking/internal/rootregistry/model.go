// Package rootregistry owns the Launcher's managed-root registry: the four
// registered roots (harness, plugins, presets, settings) and the workspace
// bindings below them.
//
// The on-disk format, the file location and the refusal codes are the ones
// `electron/main/managed/registry.ts` and `validation.ts` already wrote, so a
// registry either side produced stays readable by the other while ownership
// moves into the core. The rules are ported rather than reinterpreted: exactly
// four roots with unique ids and kinds, canonical absolute paths that are not a
// bare filesystem root, nothing under a Harness `.dsh` directory, nothing
// overlapping the existing Harness home, and workspaces that bind every root
// once with portable namespaces.
package rootregistry

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Format and Version identify the persisted document. They are the values the
// shell has always written; a different version is refused, never migrated.
const (
	Format  = "dsh-launcher.managed-root-registry"
	Version = 2
)

// RegistryFileName is the only file name the registry is ever written to.
const RegistryFileName = "managed-root-registry.json"

// MaxRegistryBytes bounds the document. It is a configuration file, not a
// database: anything larger is a corrupt or hostile input.
const MaxRegistryBytes = 256 * 1024

// Kinds are the four mutually exclusive filesystem ownership roles.
var Kinds = []string{"harness", "plugins", "presets", "settings"}

// Refusal codes, which are the ones the shell already used.
var (
	ErrInvalid             = errors.New("managed.invalid_record")
	ErrUnsupportedVersion  = errors.New("managed.unsupported_version")
	ErrRootPathInvalid     = errors.New("managed.root_path_invalid")
	ErrRootOverlap         = errors.New("managed.root_overlap")
	ErrDshRuntimeOverlap   = errors.New("managed.dsh_runtime_overlap")
	ErrNamespaceInvalid    = errors.New("managed.namespace_invalid")
	ErrNamespaceOverlap    = errors.New("managed.namespace_overlap")
	ErrWorkingDirectoryBad = errors.New("managed.working_directory_invalid")
	ErrWorkspaceExists     = errors.New("managed.workspace_exists")
	ErrMissingRegistry     = errors.New("managed.missing_registry")
	ErrPersistenceFailed   = errors.New("managed.persistence_failed")
	ErrRootSymbolicLink    = errors.New("managed.root_symbolic_link")
)

// Root is one registered root role.
type Root struct {
	RootID        string `json:"rootId"`
	Kind          string `json:"kind"`
	CanonicalPath string `json:"canonicalPath"`
}

// RootNamespace binds one root for one workspace, as a portable relative path.
type RootNamespace struct {
	RootID    string `json:"rootId"`
	Namespace string `json:"namespace"`
}

// Workspace is a Launcher workspace that references roots without duplicating
// their paths.
type Workspace struct {
	WorkspaceID                   string          `json:"workspaceId"`
	DisplayName                   string          `json:"displayName"`
	WorkingDirectoryCapabilityID  string          `json:"workingDirectoryCapabilityId"`
	WorkingDirectoryCanonicalPath string          `json:"workingDirectoryCanonicalPath"`
	RootNamespaces                []RootNamespace `json:"rootNamespaces"`
}

// Registry is the complete document.
//
// The field order is the order the shell's JSON.stringify wrote them in, so a
// registry the core publishes is byte-identical to one it would have written.
type Registry struct {
	Format     string      `json:"format"`
	Version    int         `json:"version"`
	Roots      []Root      `json:"roots"`
	Workspaces []Workspace `json:"workspaces"`
}

var opaqueID = regexp.MustCompile(`^[a-z][a-z0-9_-]{2,127}$`)

// unsafeNamespaceSegment matches the characters no platform accepts in a path
// segment plus the Windows-reserved set; it is the portable intersection.
var unsafeNamespaceSegment = regexp.MustCompile("[\x00-\x1f<>:\"|?*]")

// IsKind reports whether a value names one of the four managed root roles.
func IsKind(value string) bool {
	for _, kind := range Kinds {
		if kind == value {
			return true
		}
	}
	return false
}

// windows reports whether this core validates Windows path spelling. The core
// only ever reads registries this machine wrote, so the style is the running
// platform rather than a caller's choice.
func windows() bool { return runtime.GOOS == "windows" }

func fold(value string) string {
	if windows() {
		return strings.ToLower(value)
	}
	return value
}

// AssertOpaqueID validates an identifier the Launcher persisted.
func AssertOpaqueID(value string) error {
	if !opaqueID.MatchString(value) {
		return ErrInvalid
	}
	return nil
}

// AssertWorkspaceNamespace validates one portable relative namespace.
func AssertWorkspaceNamespace(value string) error {
	if value == "" || len(value) > 512 || strings.ContainsRune(value, '\\') {
		return ErrNamespaceInvalid
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return ErrNamespaceInvalid
		}
		if unsafeNamespaceSegment.MatchString(segment) {
			return ErrNamespaceInvalid
		}
	}
	return nil
}

// AssertCanonicalRootPath validates an absolute, already-normalized path that is
// not a filesystem root. Nothing is inferred and no default is substituted.
func AssertCanonicalRootPath(value string) error {
	if value == "" || strings.ContainsRune(value, 0) {
		return ErrRootPathInvalid
	}
	if !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return ErrRootPathInvalid
	}
	if isBareRoot(value) {
		return ErrRootPathInvalid
	}
	return nil
}

// AssertWorkspaceDisplayName validates a user-facing label, never a path.
func AssertWorkspaceDisplayName(value string) error {
	if value == "" || len(value) > 160 || strings.TrimSpace(value) != value {
		return ErrInvalid
	}
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			return ErrInvalid
		}
	}
	return nil
}

// AssertOutsideHarnessRuntimeHome rejects a Launcher path that names any `.dsh`
// directory rather than a Launcher-owned one.
func AssertOutsideHarnessRuntimeHome(value string) error {
	for _, segment := range strings.Split(filepath.Clean(value), string(os.PathSeparator)) {
		if fold(segment) == fold(".dsh") {
			return ErrDshRuntimeOverlap
		}
	}
	return nil
}

// AssertOutsideNativeDshHome rejects a Launcher path that overlaps the existing
// Harness runtime home.
func AssertOutsideNativeDshHome(value, nativeDshHome string) error {
	if err := AssertCanonicalRootPath(nativeDshHome); err != nil {
		return err
	}
	if pathsOverlap(value, nativeDshHome) {
		return ErrDshRuntimeOverlap
	}
	return nil
}

// AssertRootLayout verifies the one-to-one four-root layout.
func AssertRootLayout(roots []Root, nativeDshHome string) error {
	if len(roots) != len(Kinds) {
		return ErrInvalid
	}
	kinds := make(map[string]bool, len(roots))
	ids := make(map[string]bool, len(roots))
	for _, root := range roots {
		if err := AssertOpaqueID(root.RootID); err != nil {
			return err
		}
		if err := AssertCanonicalRootPath(root.CanonicalPath); err != nil {
			return err
		}
		if err := AssertOutsideHarnessRuntimeHome(root.CanonicalPath); err != nil {
			return err
		}
		if err := AssertOutsideNativeDshHome(root.CanonicalPath, nativeDshHome); err != nil {
			return err
		}
		if !IsKind(root.Kind) || kinds[root.Kind] || ids[root.RootID] {
			return ErrInvalid
		}
		kinds[root.Kind] = true
		ids[root.RootID] = true
	}
	for left := 0; left < len(roots); left++ {
		for right := left + 1; right < len(roots); right++ {
			if pathsOverlap(roots[left].CanonicalPath, roots[right].CanonicalPath) {
				return ErrRootOverlap
			}
		}
	}
	return nil
}

// AssertWorkspaceBinding verifies that one workspace references every
// registered root exactly once, with safe namespaces and its own directory.
func AssertWorkspaceBinding(workspace Workspace, roots []Root, nativeDshHome string) error {
	if err := AssertOpaqueID(workspace.WorkspaceID); err != nil {
		return err
	}
	if err := AssertWorkspaceDisplayName(workspace.DisplayName); err != nil {
		return err
	}
	if err := AssertOpaqueID(workspace.WorkingDirectoryCapabilityID); err != nil {
		return err
	}
	if err := AssertCanonicalRootPath(workspace.WorkingDirectoryCanonicalPath); err != nil {
		return err
	}
	if err := AssertOutsideHarnessRuntimeHome(workspace.WorkingDirectoryCanonicalPath); err != nil {
		return err
	}
	if err := AssertOutsideNativeDshHome(workspace.WorkingDirectoryCanonicalPath, nativeDshHome); err != nil {
		return err
	}
	for _, root := range roots {
		if pathsOverlap(root.CanonicalPath, workspace.WorkingDirectoryCanonicalPath) {
			return ErrWorkingDirectoryBad
		}
	}
	if len(workspace.RootNamespaces) != len(roots) {
		return ErrInvalid
	}
	expected := make(map[string]bool, len(roots))
	for _, root := range roots {
		expected[root.RootID] = true
	}
	bound := make(map[string]bool, len(workspace.RootNamespaces))
	for _, binding := range workspace.RootNamespaces {
		if err := AssertOpaqueID(binding.RootID); err != nil {
			return err
		}
		if err := AssertWorkspaceNamespace(binding.Namespace); err != nil {
			return err
		}
		if !expected[binding.RootID] || bound[binding.RootID] {
			return ErrInvalid
		}
		bound[binding.RootID] = true
	}
	return nil
}

// AssertWorkspacesDoNotOverlap rejects duplicate workspace identities, nested
// namespace ownership below one root, and overlapping working directories.
func AssertWorkspacesDoNotOverlap(workspaces []Workspace) error {
	seenWorkspace := make(map[string]bool, len(workspaces))
	seenName := make(map[string]bool, len(workspaces))
	namespaces := make(map[string][]string)
	for index, workspace := range workspaces {
		if seenWorkspace[workspace.WorkspaceID] {
			return ErrInvalid
		}
		seenWorkspace[workspace.WorkspaceID] = true
		name := fold(workspace.DisplayName)
		if seenName[name] {
			return ErrWorkspaceExists
		}
		seenName[name] = true
		for _, binding := range workspace.RootNamespaces {
			for _, existing := range namespaces[binding.RootID] {
				if namespaceOverlaps(existing, binding.Namespace) {
					return ErrNamespaceOverlap
				}
			}
			namespaces[binding.RootID] = append(namespaces[binding.RootID], binding.Namespace)
		}
		for _, other := range workspaces[index+1:] {
			if pathsOverlap(workspace.WorkingDirectoryCanonicalPath, other.WorkingDirectoryCanonicalPath) {
				return ErrWorkingDirectoryBad
			}
		}
	}
	return nil
}

func isBareRoot(value string) bool {
	volume := filepath.VolumeName(value)
	return value == volume+string(os.PathSeparator) || value == string(os.PathSeparator)
}

func pathsOverlap(left, right string) bool {
	return isSameOrAncestor(left, right) || isSameOrAncestor(right, left)
}

func isSameOrAncestor(parent, child string) bool {
	normalizedParent, normalizedChild := fold(parent), fold(child)
	if normalizedParent == normalizedChild {
		return true
	}
	relative, err := filepath.Rel(normalizedParent, normalizedChild)
	if err != nil {
		return false
	}
	return relative != "" && relative != "." && !strings.HasPrefix(relative, "..") && !filepath.IsAbs(relative)
}

func namespaceOverlaps(left, right string) bool {
	return left == right || strings.HasPrefix(left, right+"/") || strings.HasPrefix(right, left+"/")
}
