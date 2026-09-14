package gitcheckout

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// twoCommitFixture gives the tests a first commit and a second one that touches a
// file, which is what the dirty-state rule needs to have something to see.
func twoCommitFixture(t *testing.T) (string, string, string) {
	t.Helper()
	repository, first := gitFixture(t)
	if err := os.WriteFile(filepath.Join(repository, "file.txt"), []byte("content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "file.txt")
	runGit(t, repository, "-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "second")
	second := strings.TrimSpace(runGit(t, repository, "rev-parse", "HEAD"))
	runGit(t, repository, "branch", "-M", "main")
	bundle := filepath.Join(canonicalDirectory(t), "fixture.bundle")
	runGit(t, repository, "bundle", "create", bundle, "--all")
	return first, second, bundle
}

// worktreeHarness publishes a mirror from a bundle and returns everything the
// worktree operations need.
func worktreeHarness(t *testing.T, bundle string) (*Runner, Executable, ExecutionContext, InstallationPaths) {
	t.Helper()
	runner, executable, execution, paths := mirrorHarness(t)
	if _, err := CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), bundle); err != nil {
		t.Fatalf("mirror: %v", err)
	}
	return runner, executable, execution, paths
}

func TestMaterializeWorktreeCreatesAVerifiedDetachedWorktree(t *testing.T) {
	first, second, bundle := twoCommitFixture(t)
	runner, executable, execution, paths := worktreeHarness(t, bundle)
	remote := expectedOrigin(t)

	worktree, err := MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, first)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if worktree.Path != filepath.Join(paths.WorktreesPath, first) || worktree.Commit != first {
		t.Fatalf("worktree = %+v", worktree)
	}
	if head := strings.TrimSpace(runGit(t, worktree.Path, "rev-parse", "HEAD")); head != first {
		t.Fatalf("worktree HEAD = %q, want %q", head, first)
	}
	if branch := strings.TrimSpace(runGit(t, worktree.Path, "rev-parse", "--abbrev-ref", "HEAD")); branch != "HEAD" {
		t.Fatalf("worktree is not detached: %q", branch)
	}
	if _, err = VerifyWorktree(context.Background(), runner, executable, execution, paths, remote, first); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if _, err = MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, first); !errors.Is(err, ErrWorktreeExists) {
		t.Fatalf("a second materialization = %v", err)
	}

	// A second commit gets its own worktree, and that one is clean after checkout.
	secondWorktree, err := MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, second)
	if err != nil {
		t.Fatalf("materialize the second commit: %v", err)
	}
	if err = AssertWorktreeClean(context.Background(), runner, executable, execution, secondWorktree.Path); err != nil {
		t.Fatalf("a freshly materialized worktree is not clean: %v", err)
	}
}

func TestMaterializeWorktreeRefusesBadInput(t *testing.T) {
	_, _, bundle := twoCommitFixture(t)
	runner, executable, execution, paths := worktreeHarness(t, bundle)
	remote := expectedOrigin(t)

	for _, commit := range []string{"", "8f3c1f0", strings.ToUpper(fullSHA), fullSHA + "^{commit}"} {
		if _, err := MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, commit); !errors.Is(err, ErrRefInvalid) {
			t.Errorf("MaterializeWorktree(%q) = %v", commit, err)
		}
	}
	// A full SHA that the mirror does not contain is a git failure, not a
	// launcher-level refusal: the mirror was asked and answered.
	absent := strings.Repeat("a", 40)
	if _, err := MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, absent); !errors.Is(err, ErrCommandFailed) {
		t.Fatalf("a commit the mirror does not have = %v", err)
	}

	freshRunner, freshExecutable, freshExecution, freshPaths := mirrorHarness(t)
	if _, err := MaterializeWorktree(context.Background(), freshRunner, freshExecutable, freshExecution, freshPaths, remote, fullSHA); !errors.Is(err, ErrManagedPathInvalid) {
		t.Fatalf("materializing without a mirror = %v", err)
	}
}

func TestVerifyWorktreeRefusesAMovedHead(t *testing.T) {
	first, second, bundle := twoCommitFixture(t)
	runner, executable, execution, paths := worktreeHarness(t, bundle)
	remote := expectedOrigin(t)

	worktree, err := MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, first)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	runGit(t, worktree.Path, "checkout", "--detach", second)
	if _, err = VerifyWorktree(context.Background(), runner, executable, execution, paths, remote, first); !errors.Is(err, ErrWorktreeMismatch) {
		t.Fatalf("a worktree whose HEAD moved = %v", err)
	}
}

func TestAssertWorktreeCleanRefusesEveryChange(t *testing.T) {
	_, second, bundle := twoCommitFixture(t)
	runner, executable, execution, paths := worktreeHarness(t, bundle)
	remote := expectedOrigin(t)

	worktree, err := MaterializeWorktree(context.Background(), runner, executable, execution, paths, remote, second)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if err = AssertWorktreeClean(context.Background(), runner, executable, execution, worktree.Path); err != nil {
		t.Fatalf("a clean worktree = %v", err)
	}

	tracked := filepath.Join(worktree.Path, "file.txt")
	if err = os.WriteFile(tracked, []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = AssertWorktreeClean(context.Background(), runner, executable, execution, worktree.Path); !errors.Is(err, ErrRepositoryDirty) {
		t.Fatalf("a modified file = %v", err)
	}
	runGit(t, worktree.Path, "checkout", "--", "file.txt")

	untracked := filepath.Join(worktree.Path, "untracked.txt")
	if err = os.WriteFile(untracked, []byte("draft\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = AssertWorktreeClean(context.Background(), runner, executable, execution, worktree.Path); !errors.Is(err, ErrRepositoryDirty) {
		t.Fatalf("an untracked file = %v", err)
	}
	if err = os.Remove(untracked); err != nil {
		t.Fatal(err)
	}
	if err = AssertWorktreeClean(context.Background(), runner, executable, execution, worktree.Path); err != nil {
		t.Fatalf("a worktree made clean again = %v", err)
	}
	// Once the worktree is clean again, a full verification passes.
	if _, err = VerifyWorktree(context.Background(), runner, executable, execution, paths, remote, second); err != nil {
		t.Fatalf("verify after cleaning = %v", err)
	}
}
