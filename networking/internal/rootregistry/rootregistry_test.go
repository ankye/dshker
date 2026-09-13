package rootregistry

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func fixture(base string) Registry {
	return Registry{
		Format:  Format,
		Version: Version,
		Roots: []Root{
			{RootID: "root_harness", Kind: "harness", CanonicalPath: filepath.Join(base, "harness")},
			{RootID: "root_plugins", Kind: "plugins", CanonicalPath: filepath.Join(base, "plugins")},
			{RootID: "root_config", Kind: "presets", CanonicalPath: filepath.Join(base, "config")},
			{RootID: "root_settings", Kind: "settings", CanonicalPath: filepath.Join(base, "settings")},
		},
		Workspaces: []Workspace{
			{
				WorkspaceID:                   "workspace_main",
				DisplayName:                   "Main workspace",
				WorkingDirectoryCapabilityID:  "cap_workspace_main",
				WorkingDirectoryCanonicalPath: filepath.Join(base, "working-directory"),
				RootNamespaces: []RootNamespace{
					{RootID: "root_harness", Namespace: "workspaces/main"},
					{RootID: "root_plugins", Namespace: "workspaces/main"},
					{RootID: "root_config", Namespace: "workspaces/main"},
					{RootID: "root_settings", Namespace: "workspaces/main"},
				},
			},
		},
	}
}

// nativeHome is the Harness runtime home every fixture must stay outside of.
func nativeHome(base string) string { return filepath.Join(base, "native-dsh-home") }

func TestSaveAndLoadRoundTripsTheExactRecord(t *testing.T) {
	base := t.TempDir()
	store, err := Open(filepath.Join(base, "managed-root-registry.json"), nativeHome(base))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	registry := fixture(base)
	if err := store.Save(registry); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Roots) != len(registry.Roots) || len(loaded.Workspaces) != len(registry.Workspaces) {
		t.Fatalf("loaded %+v", loaded)
	}
	for index, root := range registry.Roots {
		if loaded.Roots[index] != root {
			t.Fatalf("root %d = %+v", index, loaded.Roots[index])
		}
	}
	if loaded.Workspaces[0].WorkspaceID != registry.Workspaces[0].WorkspaceID ||
		loaded.Workspaces[0].RootNamespaces[0] != registry.Workspaces[0].RootNamespaces[0] {
		t.Fatalf("workspace = %+v", loaded.Workspaces[0])
	}
	raw, err := os.ReadFile(filepath.Join(base, "managed-root-registry.json"))
	if err != nil || string(raw) == "" {
		t.Fatalf("read back: %v", err)
	}
	if len(raw) == 0 || !contains(string(raw), Format) {
		t.Fatalf("persisted file does not name its format")
	}
	// The file the core publishes is a complete document, not a fragment.
	if raw[len(raw)-1] != '\n' {
		t.Fatalf("persisted file does not end with a newline")
	}
}

func TestLoadRefusesAMissingRegistry(t *testing.T) {
	base := t.TempDir()
	store, err := Open(filepath.Join(base, "managed-root-registry.json"), nativeHome(base))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrMissingRegistry) {
		t.Fatalf("missing registry = %v", err)
	}
}

func TestOpenRefusesAnyOtherLocation(t *testing.T) {
	base := t.TempDir()
	for name, path := range map[string]string{
		"another file name": filepath.Join(base, "registry.json"),
		"a relative path":   "managed-root-registry.json",
		"an empty path":     "",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Open(path, nativeHome(base)); !errors.Is(err, ErrPersistenceFailed) {
				t.Fatalf("Open(%q) = %v", path, err)
			}
		})
	}
}

func TestSaveAndLoadRefuseASymbolicLink(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "elsewhere.json")
	if err := os.WriteFile(target, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "managed-root-registry.json")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("this filesystem cannot create a symlink: %v", err)
	}
	store, err := Open(link, nativeHome(base))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("a symlinked registry was read")
	}
	if err := store.Save(fixture(base)); !errors.Is(err, ErrRootSymbolicLink) {
		t.Fatalf("save over a symlink = %v", err)
	}
}

func TestParseRejectsAnUnknownOrMissingField(t *testing.T) {
	base := t.TempDir()
	registry := fixture(base)
	encoded, err := encode(registry)
	if err != nil {
		t.Fatal(err)
	}
	valid := string(encoded)
	if _, err := Parse([]byte(valid), nativeHome(base)); err != nil {
		t.Fatalf("the fixture does not parse: %v", err)
	}
	for name, text := range map[string]string{
		"an unknown top-level field": containsReplace(valid, "\"workspaces\":", "\"unexpected\":true,\n  \"workspaces\":"),
		"a missing root field":       containsReplace(valid, "\"canonicalPath\": ", "\"canonicalPathIgnored\": "),
		"not an object":              "[]",
		"empty input":                "",
		"trailing content":           valid + "{}",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(text), nativeHome(base)); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

func TestParseRefusesAnUnsupportedVersion(t *testing.T) {
	base := t.TempDir()
	encoded, err := encode(fixture(base))
	if err != nil {
		t.Fatal(err)
	}
	text := containsReplace(string(encoded), "\"version\": 2", "\"version\": 3")
	if _, err := Parse([]byte(text), nativeHome(base)); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("unsupported version = %v", err)
	}
}

// bareRoot is the filesystem root that contains base, spelled the platform's own
// way, so the case is portable.
func bareRoot(base string) string {
	return filepath.VolumeName(base) + string(os.PathSeparator)
}

// layoutOf builds four roots around one base, so every case below validates the
// platform's own path spelling rather than a literal one.
func layoutOf(base string, patch func(*[]Root)) []Root {
	roots := []Root{
		{RootID: "root_harness", Kind: "harness", CanonicalPath: filepath.Join(base, "harness")},
		{RootID: "root_plugins", Kind: "plugins", CanonicalPath: filepath.Join(base, "plugins")},
		{RootID: "root_config", Kind: "presets", CanonicalPath: filepath.Join(base, "presets")},
		{RootID: "root_settings", Kind: "settings", CanonicalPath: filepath.Join(base, "settings")},
	}
	if patch != nil {
		patch(&roots)
	}
	return roots
}

func TestRootLayoutRefusesNestedAndBareRoots(t *testing.T) {
	base := t.TempDir()
	native := nativeHome(base)

	nested := layoutOf(base, func(roots *[]Root) {
		(*roots)[1].CanonicalPath = filepath.Join(base, "harness", "plugins")
	})
	if err := AssertRootLayout(nested, native); !errors.Is(err, ErrRootOverlap) {
		t.Fatalf("nested roots = %v", err)
	}
	bare := layoutOf(base, func(roots *[]Root) {
		(*roots)[0].CanonicalPath = bareRoot(base)
	})
	if err := AssertRootLayout(bare, native); !errors.Is(err, ErrRootPathInvalid) {
		t.Fatalf("a filesystem root = %v", err)
	}
	// Three roots is not the registered layout.
	if err := AssertRootLayout(bare[:3], native); !errors.Is(err, ErrInvalid) {
		t.Fatalf("three roots = %v", err)
	}
	// A path that is not already canonical is refused rather than normalized.
	separator := string(os.PathSeparator)
	unnormalized := layoutOf(base, func(roots *[]Root) {
		(*roots)[0].CanonicalPath = base + separator + separator + "harness"
	})
	if err := AssertRootLayout(unnormalized, native); !errors.Is(err, ErrRootPathInvalid) {
		t.Fatalf("a non-canonical path = %v", err)
	}
}

func TestRootLayoutRefusesHarnessRuntimeOverlap(t *testing.T) {
	base := t.TempDir()
	native := nativeHome(base)

	insideDsh := layoutOf(base, func(roots *[]Root) {
		(*roots)[2].CanonicalPath = filepath.Join(base, ".dsh", "presets")
	})
	if err := AssertRootLayout(insideDsh, native); !errors.Is(err, ErrDshRuntimeOverlap) {
		t.Fatalf("a .dsh path = %v", err)
	}
	ancestorOfNative := layoutOf(base, func(roots *[]Root) {
		// The base itself contains the Harness home below it.
		(*roots)[3].CanonicalPath = base
	})
	if err := AssertRootLayout(ancestorOfNative, native); !errors.Is(err, ErrDshRuntimeOverlap) {
		t.Fatalf("an ancestor of the Harness home = %v", err)
	}
}

func TestAssertWorkspaceNamespace(t *testing.T) {
	for name, value := range map[string]string{
		"traversal":       "../escape",
		"backslash":       "workspaces\\main",
		"empty segment":   "workspaces//main",
		"current segment": "workspaces/./main",
		"absolute":        "/workspaces/main",
		"trailing slash":  "workspaces/",
		"unsafe segment":  "workspaces/ma*in",
		"empty":           "",
	} {
		t.Run(name, func(t *testing.T) {
			if err := AssertWorkspaceNamespace(value); err == nil {
				t.Fatalf("%q was accepted", value)
			}
		})
	}
	if err := AssertWorkspaceNamespace("workspaces/main"); err != nil {
		t.Fatalf("a portable namespace was refused: %v", err)
	}
}

func TestWorkspacesMustNotOverlap(t *testing.T) {
	base := t.TempDir()
	registry := fixture(base)
	second := registry.Workspaces[0]
	second.WorkspaceID = "workspace_second"
	second.DisplayName = "Second workspace"
	second.WorkingDirectoryCanonicalPath = filepath.Join(base, "second-working-directory")
	second.RootNamespaces = []RootNamespace{
		{RootID: "root_harness", Namespace: "workspaces/main/nested"},
		{RootID: "root_plugins", Namespace: "workspaces/second"},
		{RootID: "root_config", Namespace: "workspaces/second"},
		{RootID: "root_settings", Namespace: "workspaces/second"},
	}
	nested := []Workspace{registry.Workspaces[0], second}
	if err := AssertWorkspacesDoNotOverlap(nested); !errors.Is(err, ErrNamespaceOverlap) {
		t.Fatalf("nested namespaces = %v", err)
	}
	duplicateName := []Workspace{registry.Workspaces[0], second}
	duplicateName[1].DisplayName = registry.Workspaces[0].DisplayName
	duplicateName[1].RootNamespaces[0].Namespace = "workspaces/second"
	if err := AssertWorkspacesDoNotOverlap(duplicateName); !errors.Is(err, ErrWorkspaceExists) {
		t.Fatalf("duplicate display names = %v", err)
	}
	overlappingDirectory := []Workspace{registry.Workspaces[0], second}
	overlappingDirectory[1].DisplayName = "Second workspace"
	overlappingDirectory[1].WorkingDirectoryCanonicalPath = filepath.Join(base, "working-directory", "nested")
	if err := AssertWorkspacesDoNotOverlap(overlappingDirectory); !errors.Is(err, ErrWorkingDirectoryBad) {
		t.Fatalf("overlapping working directories = %v", err)
	}
}

// TestEncodeMatchesTheShellBytes pins the exact document the shell wrote:
// JSON.stringify(registry, null, 2) plus a newline. A byte difference would make
// a save/load handoff between the two implementations churn the file.
func TestEncodeMatchesTheShellBytes(t *testing.T) {
	if windows() {
		t.Skip("the fixture uses posix path spelling, which this platform does not accept")
	}
	encoded, err := encode(Registry{
		Format:  Format,
		Version: Version,
		Roots: []Root{
			{RootID: "root_harness", Kind: "harness", CanonicalPath: "/managed/harness"},
			{RootID: "root_plugins", Kind: "plugins", CanonicalPath: "/managed/plugins"},
			{RootID: "root_config", Kind: "presets", CanonicalPath: "/managed/config"},
			{RootID: "root_settings", Kind: "settings", CanonicalPath: "/managed/settings"},
		},
		Workspaces: []Workspace{
			{
				WorkspaceID:                   "workspace_main",
				DisplayName:                   "Main workspace",
				WorkingDirectoryCapabilityID:  "cap_workspace_main",
				WorkingDirectoryCanonicalPath: "/managed/working-directory",
				RootNamespaces: []RootNamespace{
					{RootID: "root_harness", Namespace: "workspaces/main"},
					{RootID: "root_plugins", Namespace: "workspaces/main"},
					{RootID: "root_config", Namespace: "workspaces/main"},
					{RootID: "root_settings", Namespace: "workspaces/main"},
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != shellGolden {
		t.Fatalf("encoded bytes differ from the shell's:\n%s", encoded)
	}
	// The golden is also a valid input for this implementation.
	if _, err := Parse([]byte(shellGolden), "/native/.dsh"); err != nil {
		t.Fatalf("the shell's own bytes were refused: %v", err)
	}
}

// shellGolden is byte-for-byte what
// JSON.stringify(registry, null, 2) + "\n" produces in the launcher.
const shellGolden = `{
  "format": "dsh-launcher.managed-root-registry",
  "version": 2,
  "roots": [
    {
      "rootId": "root_harness",
      "kind": "harness",
      "canonicalPath": "/managed/harness"
    },
    {
      "rootId": "root_plugins",
      "kind": "plugins",
      "canonicalPath": "/managed/plugins"
    },
    {
      "rootId": "root_config",
      "kind": "presets",
      "canonicalPath": "/managed/config"
    },
    {
      "rootId": "root_settings",
      "kind": "settings",
      "canonicalPath": "/managed/settings"
    }
  ],
  "workspaces": [
    {
      "workspaceId": "workspace_main",
      "displayName": "Main workspace",
      "workingDirectoryCapabilityId": "cap_workspace_main",
      "workingDirectoryCanonicalPath": "/managed/working-directory",
      "rootNamespaces": [
        {
          "rootId": "root_harness",
          "namespace": "workspaces/main"
        },
        {
          "rootId": "root_plugins",
          "namespace": "workspaces/main"
        },
        {
          "rootId": "root_config",
          "namespace": "workspaces/main"
        },
        {
          "rootId": "root_settings",
          "namespace": "workspaces/main"
        }
      ]
    }
  ]
}
`

func contains(value, fragment string) bool {
	return len(fragment) > 0 && len(value) >= len(fragment) && indexOf(value, fragment) >= 0
}

func indexOf(value, fragment string) int {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return index
		}
	}
	return -1
}

// containsReplace splices text into the first occurrence of needle, which is how
// these cases corrupt one field of an otherwise valid document.
func containsReplace(value, needle, replacement string) string {
	index := indexOf(value, needle)
	if index < 0 {
		return value
	}
	return value[:index] + replacement + value[index+len(needle):]
}
