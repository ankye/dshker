package runtimebridge

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// authorizedRoot builds a real directory tree so containment is proven against
// an actual filesystem rather than string manipulation.
func authorizedRoot(t *testing.T) Root {
	t.Helper()
	base := t.TempDir()
	resolved, err := filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatalf("resolve temp root: %v", err)
	}
	for _, name := range []string{"alpha", "beta", "gamma"} {
		if err := os.MkdirAll(filepath.Join(resolved, name), 0o755); err != nil {
			t.Fatalf("create child: %v", err)
		}
	}
	// A project marker so classification is read from the filesystem.
	if err := os.WriteFile(filepath.Join(resolved, "alpha", "project.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(resolved, "loose.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	return Root{RootID: "root-a", Name: "Work", Path: resolved}
}

func TestListsRealDirectoryContents(t *testing.T) {
	root := authorizedRoot(t)
	entries, total, code := listDirectory(directoryRequest{Version: 1, Type: "directory.list", RootID: root.RootID}, []Root{root})
	if code != "" {
		t.Fatalf("unexpected error: %s", code)
	}
	if total != 3 {
		t.Fatalf("expected 3 directories, got %d", total)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name)
		if !entry.IsDirectory {
			t.Fatalf("plain file leaked into listing: %s", entry.Name)
		}
	}
	if names[0] != "alpha" || names[1] != "beta" || names[2] != "gamma" {
		t.Fatalf("expected sorted directories, got %v", names)
	}
}

func TestReportsProjectMarkerFromFilesystem(t *testing.T) {
	root := authorizedRoot(t)
	entries, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID}, []Root{root})
	if code != "" {
		t.Fatalf("unexpected error: %s", code)
	}
	for _, entry := range entries {
		if entry.Name == "alpha" && !entry.IsProject {
			t.Fatal("alpha has a project marker but was not reported as a project")
		}
		if entry.Name == "beta" && entry.IsProject {
			t.Fatal("beta has no marker but was reported as a project")
		}
	}
}

func TestNeverExposesRemoteAbsolutePath(t *testing.T) {
	root := authorizedRoot(t)
	entries, _, _ := listDirectory(directoryRequest{Version: 1, RootID: root.RootID}, []Root{root})
	for _, entry := range entries {
		if entry.Ref == "" {
			t.Fatal("entry is missing its opaque reference")
		}
		// The reference is opaque, and no field carries a readable path.
		if entry.Name == root.Path {
			t.Fatal("entry name leaked an absolute path")
		}
	}
}

func TestRefusesUnauthorizedRoot(t *testing.T) {
	root := authorizedRoot(t)
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: "other"}, []Root{root})
	if code != "p2p.remote_root_unauthorized" {
		t.Fatalf("expected unauthorized root, got %q", code)
	}
}

func TestRefusesReferenceFromAnotherRoot(t *testing.T) {
	root := authorizedRoot(t)
	foreign := encodeRef("root-b", filepath.Join(root.Path, "alpha"))
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Ref: foreign}, []Root{root})
	if code != "p2p.remote_reference_invalid" {
		t.Fatalf("expected reference rejection, got %q", code)
	}
}

func TestRefusesTraversalOutsideRoot(t *testing.T) {
	root := authorizedRoot(t)
	outside := filepath.Dir(root.Path)
	escape := encodeRef(root.RootID, filepath.Join(root.Path, "..", filepath.Base(outside)))
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Ref: escape}, []Root{root})
	if code == "" {
		t.Fatal("traversal outside the authorized root was accepted")
	}
}

func TestRefusesSymlinkEscapingRoot(t *testing.T) {
	root := authorizedRoot(t)
	outside := t.TempDir()
	link := filepath.Join(root.Path, "escape")
	linkDirectory(t, outside, link)
	resolved, err := resolvePath(link)
	if err != nil {
		t.Fatalf("resolve symlink: %v", err)
	}
	if runtime.GOOS == "windows" && resolved == link {
		t.Fatalf("junction was not resolved: %s", link)
	}
	ref := encodeRef(root.RootID, link)
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Ref: ref}, []Root{root})
	if code != "p2p.remote_path_forbidden" {
		t.Fatalf("expected symlink escape refusal, got %q", code)
	}
}

func TestAllowsSymlinkStayingInsideRoot(t *testing.T) {
	root := authorizedRoot(t)
	link := filepath.Join(root.Path, "inside")
	linkDirectory(t, filepath.Join(root.Path, "beta"), link)
	ref := encodeRef(root.RootID, link)
	if _, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Ref: ref}, []Root{root}); code != "" {
		t.Fatalf("in-root symlink was refused: %q", code)
	}
}

func TestReportsMissingPathDistinctly(t *testing.T) {
	root := authorizedRoot(t)
	ref := encodeRef(root.RootID, filepath.Join(root.Path, "absent"))
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Ref: ref}, []Root{root})
	if code != "p2p.remote_path_missing" {
		t.Fatalf("expected missing-path status, got %q", code)
	}
}

func TestBoundsOnePageAndReportsTotal(t *testing.T) {
	root := authorizedRoot(t)
	entries, total, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Limit: 2}, []Root{root})
	if code != "" {
		t.Fatalf("unexpected error: %s", code)
	}
	if len(entries) != 2 || total != 3 {
		t.Fatalf("expected 2 of 3 entries, got %d of %d", len(entries), total)
	}
}

func TestClampsOversizedLimitToMaximum(t *testing.T) {
	root := authorizedRoot(t)
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Limit: MaxDirectoryEntries * 10}, []Root{root})
	if code != "" {
		t.Fatalf("oversized limit should clamp, got %q", code)
	}
}

func TestPaginatesWithoutRepeatingEntries(t *testing.T) {
	root := authorizedRoot(t)
	first, _, _ := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Limit: 2}, []Root{root})
	second, _, _ := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Offset: 2, Limit: 2}, []Root{root})
	if len(second) != 1 {
		t.Fatalf("expected the remaining entry, got %d", len(second))
	}
	if second[0].Name == first[0].Name || second[0].Name == first[1].Name {
		t.Fatal("pagination repeated an entry")
	}
}

func TestRefusesOffsetBeyondListing(t *testing.T) {
	root := authorizedRoot(t)
	_, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Offset: 99}, []Root{root})
	if code != "p2p.invalid_request" {
		t.Fatalf("expected invalid offset, got %q", code)
	}
}

func TestRefusesMalformedReference(t *testing.T) {
	root := authorizedRoot(t)
	for _, ref := range []string{"!!!not-base64!!!", "YWJj", ""} {
		if ref == "" {
			continue
		}
		if _, _, code := listDirectory(directoryRequest{Version: 1, RootID: root.RootID, Ref: ref}, []Root{root}); code == "" {
			t.Fatalf("malformed reference %q was accepted", ref)
		}
	}
}
