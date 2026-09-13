package integration

// Task 4.1: the core owns the managed-root registry. This drives the real
// daemon over the real private channel, because that is where the document and
// its refusal codes have to survive: a managed.* code that collapsed on the way
// would reach the shell as an unexplained failure.
import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ankye/dshker/networking/internal/rootregistry"
)

func TestCoreDaemonOwnsTheRootRegistry(t *testing.T) {
	parent, stopCore := startCoreDaemon(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_callback")
	})
	defer stopCore()
	ctx := context.Background()

	base := t.TempDir()
	filePath := filepath.Join(base, rootregistry.RegistryFileName)
	native := filepath.Join(base, "native-dsh-home")

	// Nothing is registered yet, and the refusal names what is missing.
	_, err := parent.Call(ctx, "core.roots_inspect", rootsPayload(filePath, native))
	if err == nil || err.Error() != "managed.missing_registry" {
		t.Fatalf("inspect without a registry = %v", err)
	}

	registry := rootregistry.Registry{
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
	committed, err := parent.Call(ctx, "core.roots_commit", rootsCommitPayload(filePath, native, registry))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	var answer struct {
		Registry rootregistry.Registry `json:"registry"`
	}
	if json.Unmarshal(committed, &answer) != nil || len(answer.Registry.Roots) != 4 {
		t.Fatalf("commit answered %s", committed)
	}

	// The bytes on disk are the document the shell wrote, and the core reads them
	// back through the same validator.
	raw, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("the daemon did not publish the registry: %v", err)
	}
	if _, err := rootregistry.Parse(raw, native); err != nil {
		t.Fatalf("the published document does not parse: %v", err)
	}
	inspected, err := parent.Call(ctx, "core.roots_inspect", rootsPayload(filePath, native))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	var readback struct {
		Registry rootregistry.Registry `json:"registry"`
	}
	if json.Unmarshal(inspected, &readback) != nil || readback.Registry.Roots[0] != registry.Roots[0] {
		t.Fatalf("inspect answered %s", inspected)
	}

	// A registry the core refuses keeps its own code and writes nothing.
	for _, invalid := range []struct {
		name string
		edit func(*rootregistry.Registry)
		code string
	}{
		{"nested roots", func(value *rootregistry.Registry) {
			value.Roots[1].CanonicalPath = filepath.Join(base, "harness", "plugins")
		}, "managed.root_overlap"},
		{"an unsupported version", func(value *rootregistry.Registry) {
			value.Version = 99
		}, "managed.unsupported_version"},
	} {
		broken := registry
		broken.Roots = append([]rootregistry.Root{}, registry.Roots...)
		invalid.edit(&broken)
		if _, err := parent.Call(ctx, "core.roots_commit", rootsCommitPayload(filePath, native, broken)); err == nil || err.Error() != invalid.code {
			t.Fatalf("%s = %v", invalid.name, err)
		}
	}
}

func rootsPayload(filePath, native string) any {
	return struct {
		FilePath      string `json:"filePath"`
		NativeDshHome string `json:"nativeDshHome"`
	}{FilePath: filePath, NativeDshHome: native}
}

func rootsCommitPayload(filePath, native string, registry rootregistry.Registry) any {
	return struct {
		FilePath      string                `json:"filePath"`
		NativeDshHome string                `json:"nativeDshHome"`
		Registry      rootregistry.Registry `json:"registry"`
	}{FilePath: filePath, NativeDshHome: native, Registry: registry}
}
