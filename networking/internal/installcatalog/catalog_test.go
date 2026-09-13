package installcatalog

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture builds one valid catalog with platform-native absolute paths, so the
// same cases run on macOS and Windows.
func fixture(base string) Catalog {
	git := filepath.Join(base, "git")
	node := filepath.Join(base, "node")
	pnpm := filepath.Join(base, "pnpm")
	return Catalog{
		Format:  Format,
		Version: Version,
		Toolchains: []Toolchain{
			{
				ToolchainID: "toolchain_main",
				Git: GitExecutable{
					RequestedPath: git,
					CanonicalPath: git,
					Fingerprint:   GitFingerprint{Device: 1, Inode: 2, Size: 3, ModifiedAtMilliseconds: 4},
					Version:       GitVersion{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"},
				},
				Node: NodeExecutable{
					RequestedPath: node,
					CanonicalPath: node,
					Fingerprint: ToolchainFingerprint{
						Device: 5, Inode: 6, Mode: 7, Size: 8,
						ModifiedAtMilliseconds: 9, ChangedAtMilliseconds: 10,
					},
					Version: ToolchainVersion{Major: 22, Minor: 22, Patch: 2, Text: "22.22.2"},
				},
				Pnpm: PnpmExecutable{
					RequestedPath: pnpm,
					CanonicalPath: pnpm,
					Fingerprint: ToolchainFingerprint{
						Device: 11, Inode: 12, Mode: 13, Size: 14,
						ModifiedAtMilliseconds: 15, ChangedAtMilliseconds: 16,
					},
					Launcher: PnpmLauncher{Kind: "native"},
					Version:  ToolchainVersion{Major: 9, Minor: 15, Patch: 0, Text: "9.15.0"},
				},
			},
		},
		Installations: []Installation{
			{
				InstallationID: "installation_main",
				WorkspaceID:    "workspace_main",
				ToolchainID:    "toolchain_main",
				Remote: NamedRemote{
					Name: "origin",
					Source: RemoteSource{
						DeclaredURL: "https://github.com/ankye/dshker.git",
						Identity: RemoteIdentity{
							Transport:          "https",
							Host:               "github.com",
							EffectivePort:      443,
							RepositoryPathKind: "absolute",
							RepositoryPath:     "ankye/dshker.git",
							Display:            "https://github.com:443/ankye/dshker.git",
						},
					},
				},
				Selection:         Selection{Kind: "branch", Branch: "main"},
				Commit:            strings.Repeat("a", 40),
				ObservedReference: "refs/remotes/origin/main",
				ObservedObject:    strings.Repeat("b", 40),
			},
		},
	}
}

func TestSaveAndLoadRoundTripsTheExactRecord(t *testing.T) {
	base := t.TempDir()
	store, err := Open(filepath.Join(base, CatalogFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	catalog := fixture(base)
	if err := store.Save(catalog); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Toolchains) != 1 || len(loaded.Installations) != 1 {
		t.Fatalf("loaded %+v", loaded)
	}
	if loaded.Toolchains[0].Pnpm != catalog.Toolchains[0].Pnpm {
		t.Fatalf("pnpm round trip: %+v", loaded.Toolchains[0].Pnpm)
	}
	if loaded.Installations[0].Remote != catalog.Installations[0].Remote {
		t.Fatalf("remote round trip: %+v", loaded.Installations[0].Remote)
	}
	raw, err := os.ReadFile(filepath.Join(base, CatalogFileName))
	if err != nil || raw[len(raw)-1] != '\n' {
		t.Fatalf("persisted file: %v", err)
	}
}

func TestLoadRefusesAMissingCatalog(t *testing.T) {
	base := t.TempDir()
	store, err := Open(filepath.Join(base, CatalogFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrMissingCatalog) {
		t.Fatalf("missing catalog = %v", err)
	}
}

func TestOpenRefusesAnyOtherLocation(t *testing.T) {
	base := t.TempDir()
	for name, path := range map[string]string{
		"another file name": filepath.Join(base, "catalog.json"),
		"a relative path":   CatalogFileName,
		"an empty path":     "",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Open(path); !errors.Is(err, ErrPersistenceFailed) {
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
	link := filepath.Join(base, CatalogFileName)
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("this filesystem cannot create a symlink: %v", err)
	}
	store, err := Open(link)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("a symlinked catalog was read")
	}
	if err := store.Save(fixture(base)); !errors.Is(err, ErrSymbolicLink) {
		t.Fatalf("save over a symlink = %v", err)
	}
}

func TestParseRefusesUnknownFieldsAtEveryDepth(t *testing.T) {
	base := t.TempDir()
	encoded := mustEncode(t, fixture(base))
	if _, err := Parse(encoded); err != nil {
		t.Fatalf("the fixture does not parse: %v", err)
	}
	for name, patch := range map[string]func(map[string]any){
		"a top-level field": func(document map[string]any) { document["unexpected"] = true },
		"a toolchain field": func(document map[string]any) {
			firstEntry(document, "toolchains")["unexpected"] = true
		},
		"a git fingerprint field": func(document map[string]any) {
			git := toolchainField(document, "git")
			child(git, "fingerprint")["unexpected"] = true
		},
		"a toolchain fingerprint field": func(document map[string]any) {
			node := toolchainField(document, "node")
			child(node, "fingerprint")["unexpected"] = true
		},
		"a version field": func(document map[string]any) {
			git := toolchainField(document, "git")
			child(git, "version")["unexpected"] = true
		},
		"a launcher field": func(document map[string]any) {
			pnpm := toolchainField(document, "pnpm")
			child(pnpm, "launcher")["unexpected"] = true
		},
		"a remote identity field": func(document map[string]any) {
			remote := firstEntry(document, "installations")["remote"].(map[string]any)
			child(remote, "source")["identity"].(map[string]any)["unexpected"] = true
		},
	} {
		t.Run(name, func(t *testing.T) {
			document := decodeDocument(t, encoded)
			patch(document)
			if _, err := Parse(mustEncode(t, document)); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

func TestParseRefusesAnUnsupportedVersion(t *testing.T) {
	base := t.TempDir()
	document := decodeDocument(t, mustEncode(t, fixture(base)))
	document["version"] = 4
	if _, err := Parse(mustEncode(t, document)); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("unsupported version = %v", err)
	}
}

// TestCatalogRefusesBrokenRecords covers the integrity rules the catalog carries
// rather than the field shapes.
func TestCatalogRefusesBrokenRecords(t *testing.T) {
	base := t.TempDir()
	for name, patch := range map[string]func(*Catalog){
		"a remote whose identity no longer matches its URL": func(catalog *Catalog) {
			catalog.Installations[0].Remote.Source.Identity.RepositoryPath = "ankye/other.git"
		},
		"a remote identity that gained a user": func(catalog *Catalog) {
			catalog.Installations[0].Remote.Source.Identity.SSHUser = "someone"
		},
		"an installation without its toolchain": func(catalog *Catalog) {
			catalog.Toolchains = nil
		},
		"a short commit": func(catalog *Catalog) {
			catalog.Installations[0].Commit = "abc"
		},
		"a tag selection without its tag object": func(catalog *Catalog) {
			catalog.Installations[0].Selection = Selection{Kind: "tag", Tag: "v1"}
		},
		"a branch selection carrying a tag object": func(catalog *Catalog) {
			tag := strings.Repeat("c", 40)
			catalog.Installations[0].TagObject = &tag
		},
		"a branch name with a traversal": func(catalog *Catalog) {
			catalog.Installations[0].Selection = Selection{Kind: "branch", Branch: "feature/../main"}
		},
		"a branch name starting with refs/": func(catalog *Catalog) {
			catalog.Installations[0].Selection = Selection{Kind: "branch", Branch: "refs/heads/main"}
		},
		"a version whose text disagrees": func(catalog *Catalog) {
			catalog.Toolchains[0].Git.Version.Text = "2.43.1"
		},
		"a relative executable path": func(catalog *Catalog) {
			catalog.Toolchains[0].Node.CanonicalPath = "node"
		},
		"a pnpm node-script launcher with another Node": func(catalog *Catalog) {
			other := catalog.Toolchains[0].Node
			other.RequestedPath = filepath.Join(base, "other-node")
			other.CanonicalPath = other.RequestedPath
			catalog.Toolchains[0].Pnpm.Launcher = PnpmLauncher{Kind: "node-script", Node: &other}
		},
		"a duplicate toolchain id": func(catalog *Catalog) {
			catalog.Toolchains = append(catalog.Toolchains, catalog.Toolchains[0])
		},
		"an unknown pnpm launcher": func(catalog *Catalog) {
			catalog.Toolchains[0].Pnpm.Launcher = PnpmLauncher{Kind: "shell"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			catalog := fixture(base)
			patch(&catalog)
			if err := AssertCatalog(catalog); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

func TestParseRemoteIdentity(t *testing.T) {
	for name, expected := range map[string]RemoteIdentity{
		"https://github.com/ankye/dshker.git": {
			Transport: "https", Host: "github.com", EffectivePort: 443,
			RepositoryPathKind: "absolute", RepositoryPath: "ankye/dshker.git",
			Display: "https://github.com:443/ankye/dshker.git",
		},
		"https://github.com:8443/ankye/dshker": {
			Transport: "https", Host: "github.com", EffectivePort: 8443,
			RepositoryPathKind: "absolute", RepositoryPath: "ankye/dshker",
			Display: "https://github.com:8443/ankye/dshker",
		},
		"git@github.com:ankye/dshker.git": {
			Transport: "ssh", Host: "github.com", EffectivePort: 22, SSHUser: "git",
			RepositoryPathKind: "relative", RepositoryPath: "ankye/dshker.git",
			Display: "ssh-scp://git@github.com:22:ankye/dshker.git",
		},
		"git@github.com:/srv/git/dshker.git": {
			Transport: "ssh", Host: "github.com", EffectivePort: 22, SSHUser: "git",
			RepositoryPathKind: "absolute", RepositoryPath: "srv/git/dshker.git",
			Display: "ssh://git@github.com:22/srv/git/dshker.git",
		},
		"ssh://git@github.com:2222/ankye/dshker.git": {
			Transport: "ssh", Host: "github.com", EffectivePort: 2222, SSHUser: "git",
			RepositoryPathKind: "absolute", RepositoryPath: "ankye/dshker.git",
			Display: "ssh://git@github.com:2222/ankye/dshker.git",
		},
		"https://127.0.0.1/ankye/dshker.git": {
			Transport: "https", Host: "127.0.0.1", EffectivePort: 443,
			RepositoryPathKind: "absolute", RepositoryPath: "ankye/dshker.git",
			Display: "https://127.0.0.1:443/ankye/dshker.git",
		},
	} {
		t.Run("accepts "+name, func(t *testing.T) {
			identity, ok := ParseRemoteIdentity(name)
			if !ok {
				t.Fatalf("%q was refused", name)
			}
			if identity != expected {
				t.Fatalf("%q = %+v", name, identity)
			}
		})
	}
	for name, value := range map[string]string{
		"a local path":              "/srv/git/dshker.git",
		"a file url":                "file:///srv/git/dshker.git",
		"an https user name":        "https://user@github.com/ankye/dshker.git",
		"an https query":            "https://github.com/ankye/dshker.git?ref=main",
		"an ssh password":           "ssh://user:secret@github.com/ankye/dshker.git",
		"an ambiguous segment":      "https://github.com/ankye/../dshker.git",
		"a repository with a space": "https://github.com/ankye/dsh ker.git",
		"a bracketed ipv6 port":     "https://[::1]:0/ankye/dshker.git",
	} {
		t.Run("refuses "+name, func(t *testing.T) {
			if identity, ok := ParseRemoteIdentity(value); ok {
				t.Fatalf("%q was accepted as %+v", value, identity)
			}
		})
	}
}

// TestGoldenBytesRoundTrip pins the exact document the shell wrote: the same
// bytes parse here, and re-encoding them reproduces them byte for byte. A
// difference would make a save/load handoff between the two implementations
// churn the file.
func TestGoldenBytesRoundTrip(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("the golden uses posix path spelling, which this platform does not accept")
	}
	catalog, err := Parse([]byte(shellGolden))
	if err != nil {
		t.Fatalf("the shell's own catalog was refused: %v", err)
	}
	encoded, err := encode(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != shellGolden {
		t.Fatalf("encoded bytes differ from the shell's:\n%s", encoded)
	}
}

func mustEncode(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(encoded, '\n')
}

func decodeDocument(t *testing.T, encoded []byte) map[string]any {
	t.Helper()
	var document map[string]any
	if json.Unmarshal(encoded, &document) != nil {
		t.Fatal("the fixture is not an object")
	}
	return document
}

func firstEntry(document map[string]any, key string) map[string]any {
	entries, ok := document[key].([]any)
	if !ok || len(entries) == 0 {
		return map[string]any{}
	}
	entry, _ := entries[0].(map[string]any)
	return entry
}

func toolchainField(document map[string]any, key string) map[string]any {
	field, _ := firstEntry(document, "toolchains")[key].(map[string]any)
	return field
}

func child(document map[string]any, key string) map[string]any {
	field, _ := document[key].(map[string]any)
	return field
}
