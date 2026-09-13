package integration

// Task 4.2: the core owns the managed installation catalog. This drives the real
// daemon over the real private channel, because that is where the document and
// its refusal codes have to survive: a managed.* code that collapsed on the way
// would reach the shell as an unexplained failure, and a catalog the daemon
// rewrote would churn the file on every launch.
import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ankye/dshker/networking/internal/installcatalog"
)

func TestCoreDaemonOwnsTheInstallationCatalog(t *testing.T) {
	parent, stopCore := startCoreDaemon(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_callback")
	})
	defer stopCore()
	ctx := context.Background()

	base := t.TempDir()
	filePath := filepath.Join(base, installcatalog.CatalogFileName)

	// Nothing is registered yet, and the refusal names what is missing.
	if _, err := parent.Call(ctx, "core.install_catalog_inspect", installCatalogPayload(filePath)); err == nil || err.Error() != "managed.missing_registry" {
		t.Fatalf("inspect without a catalog = %v", err)
	}

	catalog := installCatalogRecord(base)
	committed, err := parent.Call(ctx, "core.install_catalog_commit", installCatalogCommitPayload(filePath, catalog))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	var answer struct {
		Catalog installcatalog.Catalog `json:"catalog"`
	}
	if json.Unmarshal(committed, &answer) != nil || len(answer.Catalog.Toolchains) != 1 {
		t.Fatalf("commit answered %s", committed)
	}

	// The bytes on disk are read back through the same validator the shell uses.
	raw, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("the daemon did not publish the catalog: %v", err)
	}
	if _, err := installcatalog.Parse(raw); err != nil {
		t.Fatalf("the published document does not parse: %v", err)
	}
	inspected, err := parent.Call(ctx, "core.install_catalog_inspect", installCatalogPayload(filePath))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	var readback struct {
		Catalog installcatalog.Catalog `json:"catalog"`
	}
	if json.Unmarshal(inspected, &readback) != nil || readback.Catalog.Toolchains[0] != catalog.Toolchains[0] {
		t.Fatalf("inspect answered %s", inspected)
	}

	// A catalog the core refuses keeps its own code and writes nothing.
	before := raw
	for _, invalid := range []struct {
		name string
		edit func(*installcatalog.Catalog)
		code string
	}{
		{"a duplicate toolchain id", func(value *installcatalog.Catalog) {
			value.Toolchains = append(value.Toolchains, value.Toolchains[0])
		}, "managed.invalid_record"},
		{"an unsupported version", func(value *installcatalog.Catalog) {
			value.Version = 99
		}, "managed.invalid_record"},
	} {
		broken := catalog
		broken.Toolchains = append([]installcatalog.Toolchain{}, catalog.Toolchains...)
		invalid.edit(&broken)
		if _, err := parent.Call(ctx, "core.install_catalog_commit", installCatalogCommitPayload(filePath, broken)); err == nil || err.Error() != invalid.code {
			t.Fatalf("%s = %v", invalid.name, err)
		}
	}
	after, err := os.ReadFile(filePath)
	if err != nil || string(after) != string(before) {
		t.Fatalf("a refused commit changed the published catalog: %v", err)
	}
}

// TestCoreDaemonReadsTheShellCatalog proves the daemon accepts a catalog the
// TypeScript shell wrote, which is what the 4.2b switch depends on: the shell
// stops writing and the core takes over the same bytes.
func TestCoreDaemonReadsTheShellCatalog(t *testing.T) {
	parent, stopCore := startCoreDaemon(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_callback")
	})
	defer stopCore()

	golden, err := os.ReadFile(filepath.Join("..", "internal", "installcatalog", "testdata", "managed-installation-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	filePath := filepath.Join(base, installcatalog.CatalogFileName)
	if err := os.WriteFile(filePath, golden, 0o600); err != nil {
		t.Fatal(err)
	}
	inspected, err := parent.Call(context.Background(), "core.install_catalog_inspect", installCatalogPayload(filePath))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	var answer struct {
		Catalog struct {
			Installations []struct {
				InstallationID string `json:"installationId"`
			} `json:"installations"`
		} `json:"catalog"`
	}
	if err := json.Unmarshal(inspected, &answer); err != nil {
		t.Fatal(err)
	}
	if len(answer.Catalog.Installations) != 1 || answer.Catalog.Installations[0].InstallationID != "installation_main" {
		t.Fatalf("inspect answered %s", inspected)
	}
}

func installCatalogPayload(filePath string) any {
	return struct {
		FilePath string `json:"filePath"`
	}{FilePath: filePath}
}

func installCatalogCommitPayload(filePath string, catalog installcatalog.Catalog) any {
	return struct {
		FilePath string                 `json:"filePath"`
		Catalog  installcatalog.Catalog `json:"catalog"`
	}{FilePath: filePath, Catalog: catalog}
}

// installCatalogRecord builds one valid catalog with platform-native absolute
// paths, so the same case runs on macOS and Windows.
func installCatalogRecord(base string) installcatalog.Catalog {
	git := filepath.Join(base, "git")
	node := filepath.Join(base, "node")
	pnpm := filepath.Join(base, "pnpm")
	return installcatalog.Catalog{
		Format:  installcatalog.Format,
		Version: installcatalog.Version,
		Toolchains: []installcatalog.Toolchain{
			{
				ToolchainID: "toolchain_main",
				Git: installcatalog.GitExecutable{
					RequestedPath: git,
					CanonicalPath: git,
					Fingerprint:   installcatalog.GitFingerprint{Device: 1, Inode: 2, Size: 3, ModifiedAtMilliseconds: 4},
					Version:       installcatalog.GitVersion{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"},
				},
				Node: installcatalog.NodeExecutable{
					RequestedPath: node,
					CanonicalPath: node,
					Fingerprint: installcatalog.ToolchainFingerprint{
						Device: 5, Inode: 6, Mode: 7, Size: 8,
						ModifiedAtMilliseconds: 9, ChangedAtMilliseconds: 10,
					},
					Version: installcatalog.ToolchainVersion{Major: 22, Minor: 22, Patch: 2, Text: "22.22.2"},
				},
				Pnpm: installcatalog.PnpmExecutable{
					RequestedPath: pnpm,
					CanonicalPath: pnpm,
					Fingerprint: installcatalog.ToolchainFingerprint{
						Device: 11, Inode: 12, Mode: 13, Size: 14,
						ModifiedAtMilliseconds: 15, ChangedAtMilliseconds: 16,
					},
					Launcher: installcatalog.PnpmLauncher{Kind: "native"},
					Version:  installcatalog.ToolchainVersion{Major: 9, Minor: 15, Patch: 0, Text: "9.15.0"},
				},
			},
		},
		Installations: []installcatalog.Installation{},
	}
}
