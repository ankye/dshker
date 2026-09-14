package gitcheckout

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestNewInstallationPathsBuildsTheFixedLayout(t *testing.T) {
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatalf("layout: %v", err)
	}
	installation := filepath.Join(namespace, "dsh-launcher", "managed-installations", "installation-1")
	expected := map[string]string{
		"installation": paths.InstallationPath,
		"mirror":       paths.MirrorPath,
		"worktrees":    paths.WorktreesPath,
		"staging":      paths.StagingPath,
		"lock":         paths.LockPath,
	}
	for name, want := range map[string]string{
		"installation": installation,
		"mirror":       filepath.Join(installation, "mirror.git"),
		"worktrees":    filepath.Join(installation, "worktrees"),
		"staging":      filepath.Join(installation, "staging"),
		"lock":         filepath.Join(installation, "operation.lock"),
	} {
		if expected[name] != want {
			t.Errorf("%s path = %q, want %q", name, expected[name], want)
		}
	}

	refusals := []struct {
		namespace string
		id        string
	}{
		{namespace: "relative", id: "installation-1"},
		{namespace: namespace + string(filepath.Separator) + ".", id: "installation-1"},
		{namespace: string(filepath.Separator), id: "installation-1"},
		{namespace: namespace, id: ""},
		{namespace: namespace, id: "ab"},
		{namespace: namespace, id: "Installation-1"},
		{namespace: namespace, id: "1installation"},
		{namespace: namespace, id: "../evil"},
		{namespace: namespace, id: "evil/child"},
		{namespace: namespace, id: "-installation"},
		{namespace: namespace, id: strings.Repeat("a", 129)},
	}
	for _, refusal := range refusals {
		if _, err := NewInstallationPaths(refusal.namespace, refusal.id); !errors.Is(err, ErrManagedPathInvalid) {
			t.Errorf("NewInstallationPaths(%q, %q) = %v", refusal.namespace, refusal.id, err)
		}
	}
}

func TestEnsureInstallationDirectoriesCreatesAndRefuses(t *testing.T) {
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatal(err)
	}
	if err = EnsureInstallationDirectories(paths); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	for _, directory := range []string{paths.InstallationPath, paths.WorktreesPath, paths.StagingPath} {
		info, statErr := os.Lstat(directory)
		if statErr != nil || !info.IsDir() {
			t.Fatalf("%s was not created: %v", directory, statErr)
		}
		if !isWindows() && info.Mode().Perm() != 0o700 {
			t.Errorf("%s mode = %v, want 0700", directory, info.Mode().Perm())
		}
	}
	// The mirror is not created here: creating it is the mirror rules' job.
	if _, err = os.Lstat(paths.MirrorPath); !os.IsNotExist(err) {
		t.Fatalf("the mirror was created: %v", err)
	}
	if err = EnsureInstallationDirectories(paths); err != nil {
		t.Fatalf("a second ensure = %v", err)
	}

	// A namespace that is a symlink, or a file, is refused before anything is
	// created below it.
	elsewhere := canonicalDirectory(t)
	link := filepath.Join(canonicalDirectory(t), "namespace-link")
	if err = os.Symlink(elsewhere, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if err = AssertCanonicalExistingDirectory(link, "Managed Harness namespace"); !errors.Is(err, ErrManagedPathInvalid) {
		t.Fatalf("a symlinked namespace = %v", err)
	}

	file := filepath.Join(canonicalDirectory(t), "namespace-file")
	if err = os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = AssertCanonicalExistingDirectory(file, "Managed Harness namespace"); !errors.Is(err, ErrManagedPathInvalid) {
		t.Fatalf("a namespace that is a file = %v", err)
	}
	if _, err = NewInstallationPaths(file, "installation-1"); err != nil {
		t.Fatalf("the layout is derived before the namespace is inspected: %v", err)
	}

	// An unexpected file where a launcher-owned directory belongs is refused
	// rather than replaced.
	blocked := canonicalDirectory(t)
	blockedPaths, err := NewInstallationPaths(blocked, "installation-2")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(blocked, "dsh-launcher"), []byte("in the way"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = EnsureInstallationDirectories(blockedPaths); !errors.Is(err, ErrManagedPathEscape) {
		t.Fatalf("a file where a directory belongs = %v", err)
	}
}

func TestAssertManagedTargetRefusesLinksAndEscapes(t *testing.T) {
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatal(err)
	}
	if err = EnsureInstallationDirectories(paths); err != nil {
		t.Fatal(err)
	}
	if err = AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); !errors.Is(err, ErrManagedPathInvalid) {
		t.Fatalf("a missing target = %v", err)
	}

	if err = os.Mkdir(paths.MirrorPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err = AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		t.Fatalf("a real directory = %v", err)
	}

	linkTarget := filepath.Join(canonicalDirectory(t), "elsewhere")
	if err = os.Mkdir(linkTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(paths.WorktreesPath, strings.Repeat("a", 40))
	if err = os.Symlink(linkTarget, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if err = AssertManagedTarget(paths, link, "Managed Git worktree"); !errors.Is(err, ErrManagedPathEscape) {
		t.Fatalf("a symlinked target = %v", err)
	}
	if err = AssertContainedManagedPath(paths, linkTarget); !errors.Is(err, ErrManagedPathEscape) {
		t.Fatalf("a path outside the namespace = %v", err)
	}
}

func TestOperationLockIsNonStealable(t *testing.T) {
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatal(err)
	}
	lock, err := AcquireOperationLock(paths)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	owner, err := os.ReadFile(filepath.Join(paths.LockPath, "owner.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^{"ownerId":"[0-9a-f]{32}"}
$`).Match(owner) {
		t.Fatalf("owner record = %q", owner)
	}
	if _, err = AcquireOperationLock(paths); !errors.Is(err, ErrOperationLocked) {
		t.Fatalf("a second acquire = %v", err)
	}
	if err = lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err = lock.Release(); !errors.Is(err, ErrOperationLockLost) {
		t.Fatalf("a second release = %v", err)
	}
	second, err := AcquireOperationLock(paths)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}

	// A lock whose owner record was replaced is not ours to remove.
	if err = os.WriteFile(filepath.Join(paths.LockPath, "owner.json"), []byte(ownerRecord("someone-else")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = second.Release(); !errors.Is(err, ErrOperationLockLost) {
		t.Fatalf("a taken-over lock = %v", err)
	}
	if _, err = os.Lstat(paths.LockPath); err != nil {
		t.Fatalf("a lock that is not ours was removed: %v", err)
	}
}

func TestManagedWorktreePathNeedsAFullCommit(t *testing.T) {
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatal(err)
	}
	target, err := ManagedWorktreePath(paths, fullSHA)
	if err != nil {
		t.Fatalf("worktree path: %v", err)
	}
	if target != filepath.Join(paths.WorktreesPath, fullSHA) {
		t.Fatalf("worktree path = %q", target)
	}
	for _, commit := range []string{"", "8f3c1f0", strings.ToUpper(fullSHA), fullSHA + "^{commit}"} {
		if _, err = ManagedWorktreePath(paths, commit); !errors.Is(err, ErrRefInvalid) {
			t.Errorf("ManagedWorktreePath(%q) = %v", commit, err)
		}
	}
}

// TestContainmentComparesPathElements records a deliberate difference from the
// shell: it refused any relative path beginning with two dots, which also refuses
// a sibling directory legitimately named "..notes". This compares path elements
// instead, so a sibling is contained while a real escape is still refused.
func TestContainmentComparesPathElements(t *testing.T) {
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(namespace, "..notes", "inside")
	if err = AssertContainedManagedPath(paths, sibling); err != nil {
		t.Fatalf("a contained sibling was refused: %v", err)
	}
	for _, outside := range []string{
		filepath.Dir(namespace),
		filepath.Join(namespace, "..", filepath.Base(namespace)),
		filepath.Join(namespace, "dsh-launcher", "..", "..", "escape"),
	} {
		if err = AssertContainedManagedPath(paths, outside); !errors.Is(err, ErrManagedPathEscape) && !errors.Is(err, ErrManagedPathInvalid) {
			t.Errorf("AssertContainedManagedPath(%q) = %v", outside, err)
		}
	}
}

func TestSameRegisteredPathIgnoresSpellingThatNamesOneDirectory(t *testing.T) {
	directory := canonicalDirectory(t)
	if !SameRegisteredPath(directory, directory+string(filepath.Separator)) {
		t.Fatal("a trailing separator was treated as another directory")
	}
	if !SameRegisteredPath(filepath.Join(directory, "sub", ".."), directory) {
		t.Fatal("an unnormalized spelling was treated as another directory")
	}
	if SameRegisteredPath(directory, filepath.Join(directory, "sub")) {
		t.Fatal("two different directories compared equal")
	}
	if isWindows() {
		if !SameRegisteredPath(directory, strings.ToUpper(directory)) {
			t.Fatal("Windows path matching is case-insensitive")
		}
		return
	}
	if SameRegisteredPath(directory, strings.ToUpper(directory)) {
		t.Fatal("posix path matching is case-sensitive")
	}
}
