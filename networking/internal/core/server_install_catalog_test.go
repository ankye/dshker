package core

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ankye/dshker/networking/internal/installcatalog"
)

func installCatalogRequest(t *testing.T, filePath string, catalog *installcatalog.Catalog) json.RawMessage {
	t.Helper()
	request := struct {
		FilePath string                  `json:"filePath"`
		Catalog  *installcatalog.Catalog `json:"catalog,omitempty"`
	}{FilePath: filePath, Catalog: catalog}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

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

// TestInstallCatalogCommitAndInspectRoundTrip drives the adapter the shell calls:
// the core writes the catalog, reads it back, and answers with the document's own
// shape so the shell parses it with the validator it used while it owned the file.
func TestInstallCatalogCommitAndInspectRoundTrip(t *testing.T) {
	base := t.TempDir()
	filePath := filepath.Join(base, installcatalog.CatalogFileName)
	catalog := installCatalogRecord(base)

	committed, err := Handle(context.Background(), "core.install_catalog_commit", installCatalogRequest(t, filePath, &catalog))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	result, ok := committed.(installCatalogResult)
	if !ok || len(result.Catalog.Toolchains) != 1 {
		t.Fatalf("commit returned %T", committed)
	}
	if _, err := os.Stat(filePath); err != nil {
		t.Fatalf("the catalog was not published: %v", err)
	}

	inspected, err := Handle(context.Background(), "core.install_catalog_inspect", installCatalogRequest(t, filePath, nil))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	readback, ok := inspected.(installCatalogResult)
	if !ok || readback.Catalog.Toolchains[0] != catalog.Toolchains[0] {
		t.Fatalf("inspect returned %+v", inspected)
	}
	encoded, err := json.Marshal(inspected)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Catalog json.RawMessage `json:"catalog"`
	}
	if json.Unmarshal(encoded, &envelope) != nil || len(envelope.Catalog) == 0 {
		t.Fatalf("the answer is not the catalog shape: %s", encoded)
	}
}

// TestInstallCatalogRefusalsKeepTheirManagedCodes pins the codes the shell's own
// error map uses: they cross this channel unchanged rather than collapsing to a
// p2p code.
func TestInstallCatalogRefusalsKeepTheirManagedCodes(t *testing.T) {
	base := t.TempDir()
	filePath := filepath.Join(base, installcatalog.CatalogFileName)
	if _, err := Handle(context.Background(), "core.install_catalog_inspect", installCatalogRequest(t, filePath, nil)); !errors.Is(err, installcatalog.ErrMissingCatalog) {
		t.Fatalf("missing catalog = %v", err)
	}

	broken := installCatalogRecord(base)
	broken.Installations = []installcatalog.Installation{{InstallationID: "installation_main"}}
	if _, err := Handle(context.Background(), "core.install_catalog_commit", installCatalogRequest(t, filePath, &broken)); !errors.Is(err, installcatalog.ErrInvalid) {
		t.Fatalf("a broken catalog = %v", err)
	}
	// A refused commit leaves nothing behind.
	if _, err := os.Stat(filePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused commit published a file: %v", err)
	}

	// The path is not a caller's choice: only the one catalog file name is owned.
	if _, err := Handle(context.Background(), "core.install_catalog_inspect", installCatalogRequest(t, filepath.Join(base, "catalog.json"), nil)); !errors.Is(err, installcatalog.ErrPersistenceFailed) {
		t.Fatalf("another file name = %v", err)
	}
}

// TestInstallCatalogVersionRefusalIsDistinct keeps the two version refusals
// apart, exactly as the shell does: its writer refuses a mismatched identity as
// a malformed record, while its reader reports an unsupported version so the
// launch can explain that another Launcher wrote the file.
func TestInstallCatalogVersionRefusalIsDistinct(t *testing.T) {
	base := t.TempDir()
	filePath := filepath.Join(base, installcatalog.CatalogFileName)
	catalog := installCatalogRecord(base)
	catalog.Version = installcatalog.Version + 1
	if _, err := Handle(context.Background(), "core.install_catalog_commit", installCatalogRequest(t, filePath, &catalog)); !errors.Is(err, installcatalog.ErrInvalid) {
		t.Fatalf("committing a mismatched identity = %v", err)
	}

	// A file another Launcher version wrote is refused by name on the way in.
	published := installCatalogRecord(base)
	published.Version = installcatalog.Version + 1
	encoded, err := json.Marshal(published)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Handle(context.Background(), "core.install_catalog_inspect", installCatalogRequest(t, filePath, nil)); !errors.Is(err, installcatalog.ErrUnsupportedVersion) {
		t.Fatalf("inspecting a newer catalog = %v", err)
	}
}

func TestInstallCatalogRejectsMalformedPayloads(t *testing.T) {
	for name, payload := range map[string]string{
		"a missing field":  `{"catalog":{}}`,
		"an unknown field": `{"filePath":"/x","extra":1}`,
		"not an object":    `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Handle(context.Background(), "core.install_catalog_inspect", json.RawMessage(payload)); err == nil {
				t.Fatalf("%s was accepted", payload)
			}
		})
	}
}

// TestInstallCatalogInspectOfTheShellGolden proves the core reads a catalog the
// TypeScript shell wrote, which is what the switch in 4.2b depends on.
func TestInstallCatalogInspectOfTheShellGolden(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("the golden uses posix path spelling, which this platform does not accept")
	}
	base := t.TempDir()
	filePath := filepath.Join(base, installcatalog.CatalogFileName)
	golden, err := os.ReadFile(filepath.Join("..", "installcatalog", "testdata", "managed-installation-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, golden, 0o600); err != nil {
		t.Fatal(err)
	}
	inspected, err := Handle(context.Background(), "core.install_catalog_inspect", installCatalogRequest(t, filePath, nil))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	result, ok := inspected.(installCatalogResult)
	if !ok || len(result.Catalog.Installations) != 1 {
		t.Fatalf("inspect returned %+v", inspected)
	}
	if result.Catalog.Installations[0].Commit != strings.Repeat("a", 40) {
		t.Fatalf("inspect lost the installation: %+v", result.Catalog.Installations[0])
	}
}
