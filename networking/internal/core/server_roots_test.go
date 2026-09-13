package core

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ankye/dshker/networking/internal/rootregistry"
)

func rootsRequest(filePath, nativeDshHome string) json.RawMessage {
	encoded, err := json.Marshal(struct {
		FilePath      string `json:"filePath"`
		NativeDshHome string `json:"nativeDshHome"`
	}{FilePath: filePath, NativeDshHome: nativeDshHome})
	if err != nil {
		panic(err)
	}
	return encoded
}

func rootsRegistry(base string) rootregistry.Registry {
	return rootregistry.Registry{
		Format:  rootregistry.Format,
		Version: rootregistry.Version,
		Roots: []rootregistry.Root{
			{RootID: "root_harness", Kind: "harness", CanonicalPath: filepath.Join(base, "harness")},
			{RootID: "root_plugins", Kind: "plugins", CanonicalPath: filepath.Join(base, "plugins")},
			{RootID: "root_config", Kind: "presets", CanonicalPath: filepath.Join(base, "config")},
			{RootID: "root_settings", Kind: "settings", CanonicalPath: filepath.Join(base, "settings")},
		},
		Workspaces: []rootregistry.Workspace{},
	}
}

// TestRootsCommitAndInspectRoundTrip drives the adapter the shell calls: the core
// writes the registry, reads it back, and answers with the document's own shape.
func TestRootsCommitAndInspectRoundTrip(t *testing.T) {
	base := t.TempDir()
	filePath := filepath.Join(base, rootregistry.RegistryFileName)
	native := filepath.Join(base, "native-dsh-home")
	registry := rootsRegistry(base)

	committed, err := Handle(context.Background(), "core.roots_commit", rootsCommitRequest(t, filePath, native, registry))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	result, ok := committed.(rootsResult)
	if !ok || len(result.Registry.Roots) != 4 {
		t.Fatalf("commit returned %T", committed)
	}
	if _, err := os.Stat(filePath); err != nil {
		t.Fatalf("the registry was not published: %v", err)
	}

	inspected, err := Handle(context.Background(), "core.roots_inspect", rootsRequest(filePath, native))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	readback, ok := inspected.(rootsResult)
	if !ok || readback.Registry.Roots[0] != registry.Roots[0] {
		t.Fatalf("inspect returned %+v", inspected)
	}
	// The answer carries the registry document itself, so the shell parses it with
	// the validator it used while it owned the file.
	encoded, err := json.Marshal(inspected)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Registry json.RawMessage `json:"registry"`
	}
	if json.Unmarshal(encoded, &envelope) != nil || len(envelope.Registry) == 0 {
		t.Fatalf("the answer is not the registry shape: %s", encoded)
	}
}

func rootsCommitRequest(t *testing.T, filePath, native string, registry rootregistry.Registry) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(struct {
		FilePath      string                `json:"filePath"`
		NativeDshHome string                `json:"nativeDshHome"`
		Registry      rootregistry.Registry `json:"registry"`
	}{FilePath: filePath, NativeDshHome: native, Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// TestRootsRefusalsKeepTheirManagedCodes pins the codes the shell's own error map
// uses: they cross this channel unchanged rather than collapsing to a p2p code.
func TestRootsRefusalsKeepTheirManagedCodes(t *testing.T) {
	base := t.TempDir()
	native := filepath.Join(base, "native-dsh-home")
	if _, err := Handle(context.Background(), "core.roots_inspect", rootsRequest(filepath.Join(base, rootregistry.RegistryFileName), native)); !errors.Is(err, rootregistry.ErrMissingRegistry) {
		t.Fatalf("missing registry = %v", err)
	}

	nested := rootsRegistry(base)
	nested.Roots[1].CanonicalPath = filepath.Join(base, "harness", "plugins")
	if _, err := Handle(context.Background(), "core.roots_commit", rootsCommitRequest(t, filepath.Join(base, rootregistry.RegistryFileName), native, nested)); !errors.Is(err, rootregistry.ErrRootOverlap) {
		t.Fatalf("nested roots = %v", err)
	}
	// A refused commit leaves nothing behind.
	if _, err := os.Stat(filepath.Join(base, rootregistry.RegistryFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused commit published a file: %v", err)
	}

	// The registry path is not a caller's choice: only the one file name is owned.
	other, err := rootregistry.Open(filepath.Join(base, "registry.json"), native)
	if err == nil || other != nil {
		t.Fatalf("Open accepted another file name")
	}
	if _, err := Handle(context.Background(), "core.roots_inspect", rootsRequest(filepath.Join(base, "registry.json"), native)); !errors.Is(err, rootregistry.ErrPersistenceFailed) {
		t.Fatalf("another file name = %v", err)
	}
}

func TestRootsRejectMalformedPayloads(t *testing.T) {
	for name, payload := range map[string]string{
		"a missing field":  `{"filePath":"/x"}`,
		"an unknown field": `{"filePath":"/x","nativeDshHome":"/y","extra":1}`,
		"not an object":    `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Handle(context.Background(), "core.roots_inspect", json.RawMessage(payload)); err == nil {
				t.Fatalf("%s was accepted", payload)
			}
		})
	}
}
