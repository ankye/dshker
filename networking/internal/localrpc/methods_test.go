package localrpc

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestMethodTableIsWellFormed(t *testing.T) {
	if len(Methods) == 0 {
		t.Fatal("the published method table is empty")
	}
	seen := make(map[string]bool, len(Methods))
	for _, method := range Methods {
		if !ValidMethodName(method.Name) {
			t.Fatalf("malformed method name %q", method.Name)
		}
		if seen[method.Name] {
			t.Fatalf("duplicate method %q", method.Name)
		}
		seen[method.Name] = true
		if method.Role != RoleShell && method.Role != RoleParent {
			t.Fatalf("method %q has unknown role %q", method.Name, method.Role)
		}
	}
	for _, name := range []string{"runtime.connect", "peer.state"} {
		method, ok := Lookup(name)
		if !ok || method.Role != RoleParent {
			t.Fatalf("callback %q is not published as a parent-role method", name)
		}
	}
	if _, ok := Lookup("core.missing"); ok {
		t.Fatal("Lookup reported an unpublished method")
	}
	invalid := []string{"", ".", "a.", ".a", "a..b", "a b", "a/b", "noseparator", strings.Repeat("a", MaxMethodBytes+1)}
	for _, name := range invalid {
		if ValidMethodName(name) {
			t.Fatalf("ValidMethodName accepted %q", name)
		}
	}
}

// TestMethodTableMatchesShippedDispatch keeps the published table honest: a
// renamed method cannot stay published, and a published method cannot be absent
// from the implementation.
func TestMethodTableMatchesShippedDispatch(t *testing.T) {
	implemented := implementedMethodNames(t)
	for _, method := range Methods {
		if !implemented[method.Name] {
			t.Errorf("method %q is published but absent from internal/helper and internal/peer", method.Name)
		}
	}
}

var methodLiteralPattern = regexp.MustCompile("\"([a-z][a-zA-Z]*\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)*)\"")

// implementedMethodNames collects the quoted group.name literals of the
// packages that implement the peer surface.
func implementedMethodNames(t *testing.T) map[string]bool {
	t.Helper()
	found := map[string]bool{}
	for _, dir := range []string{"../helper", "../peer", "../core"} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read %s: %v", dir, err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatalf("read %s: %v", name, err)
			}
			for _, match := range methodLiteralPattern.FindAllStringSubmatch(string(data), -1) {
				found[match[1]] = true
			}
		}
	}
	if len(found) == 0 {
		t.Fatal("no method literals found; the scan directory is wrong")
	}
	return found
}
