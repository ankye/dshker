package gitcheckout

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// bundleFixture creates a repository with a branch and a tag, then exports it as
// one bundle: a bundle is how a managed installation is imported in production,
// and unlike a network remote it can be built inside a test.
func bundleFixture(t *testing.T) (string, string, string) {
	t.Helper()
	repository, head := gitFixture(t)
	runGit(t, repository, "tag", "v1.0.0")
	runGit(t, repository, "branch", "-M", "main")
	bundle := filepath.Join(canonicalDirectory(t), "fixture.bundle")
	runGit(t, repository, "bundle", "create", bundle, "--all")
	return repository, head, bundle
}

func runGitRaw(t *testing.T, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", arguments...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=0")
	output, err := command.CombinedOutput()
	if err != nil {
		if isMissingGit(err) {
			t.Skipf("git cannot be started on this machine: %v", err)
		}
		t.Fatalf("git %s: %v\n%s", strings.Join(arguments, " "), err, output)
	}
	return string(output)
}

// mirrorHarness prepares a pinned git, a managed layout and the execution context
// every mirror operation runs under.
func mirrorHarness(t *testing.T) (*Runner, Executable, ExecutionContext, InstallationPaths) {
	t.Helper()
	executable, err := PinExecutable(machineGit(t))
	if err != nil {
		t.Fatal(err)
	}
	namespace := canonicalDirectory(t)
	paths, err := NewInstallationPaths(namespace, "installation-1")
	if err != nil {
		t.Fatal(err)
	}
	if err = EnsureInstallationDirectories(paths); err != nil {
		t.Fatal(err)
	}
	return NewRunner(), executable, executionContext(t, namespace), paths
}

func TestCreateMirrorFromBundlePublishesAVerifiedMirror(t *testing.T) {
	_, head, bundle := bundleFixture(t)
	runner, executable, execution, paths := mirrorHarness(t)

	mirror, err := CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), bundle)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if mirror.Path != paths.MirrorPath {
		t.Fatalf("mirror path = %q", mirror.Path)
	}
	if state := strings.TrimSpace(runGitRaw(t, "--git-dir", mirror.Path, "rev-parse", "--is-bare-repository")); state != "true" {
		t.Fatalf("mirror is not bare: %q", state)
	}
	// The imported branch lives in the remote-tracking namespace, so resolving a
	// revision later is identical to a mirror built from the network remote.
	observed := strings.TrimSpace(runGitRaw(t, "--git-dir", mirror.Path, "rev-parse", "--verify", "refs/remotes/origin/main"))
	if observed != head {
		t.Fatalf("refs/remotes/origin/main = %q, want %q", observed, head)
	}
	runGitRaw(t, "--git-dir", mirror.Path, "rev-parse", "--verify", "refs/tags/v1.0.0")
	staging, err := os.ReadDir(paths.StagingPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(staging) != 0 {
		t.Fatalf("staging was left behind: %v", staging)
	}

	inspected, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspected.Path != paths.MirrorPath {
		t.Fatalf("inspected path = %q", inspected.Path)
	}
	if _, err = CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), bundle); !errors.Is(err, ErrMirrorExists) {
		t.Fatalf("a second creation = %v", err)
	}
}

func TestCreateMirrorRefusesAnInvalidBundle(t *testing.T) {
	_, _, bundle := bundleFixture(t)
	runner, executable, execution, paths := mirrorHarness(t)

	directory := filepath.Dir(bundle)
	for _, bundlePath := range []string{
		"relative.bundle",
		filepath.Join(directory, "missing.bundle"),
		directory,
	} {
		if _, err := CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), bundlePath); !errors.Is(err, ErrRepositoryInvalid) {
			t.Errorf("CreateMirrorFromBundle(%q) = %v", bundlePath, err)
		}
	}
	if _, err := os.Lstat(paths.MirrorPath); !os.IsNotExist(err) {
		t.Fatalf("a refused creation published a mirror: %v", err)
	}

	link := filepath.Join(directory, "linked.bundle")
	if err := os.Symlink(bundle, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, err := CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), link); !errors.Is(err, ErrRepositoryInvalid) {
		t.Fatalf("a symlinked bundle = %v", err)
	}
}

func TestCreateMirrorRefusesToRunUnderSomeoneElseLock(t *testing.T) {
	_, _, bundle := bundleFixture(t)
	runner, executable, execution, paths := mirrorHarness(t)

	lock, err := AcquireOperationLock(paths)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = lock.Release()
	}()
	if _, err = CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), bundle); !errors.Is(err, ErrOperationLocked) {
		t.Fatalf("a creation while the lock is held = %v", err)
	}
}

func TestMirrorOperationsRefuseAMissingMirror(t *testing.T) {
	runner, executable, execution, paths := mirrorHarness(t)
	if _, err := FetchMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); !errors.Is(err, ErrManagedPathInvalid) {
		t.Fatalf("fetch without a mirror = %v", err)
	}
	if _, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); !errors.Is(err, ErrManagedPathInvalid) {
		t.Fatalf("inspect without a mirror = %v", err)
	}
}

// TestVerifyBareMirrorRefusesATamperedMirror is the rule the whole mirror exists
// for: it may only ever fetch from the one URL that was confirmed.
func TestVerifyBareMirrorRefusesATamperedMirror(t *testing.T) {
	repository, _, bundle := bundleFixture(t)
	runner, executable, execution, paths := mirrorHarness(t)
	if _, err := CreateMirrorFromBundle(context.Background(), runner, executable, execution, paths, expectedOrigin(t), bundle); err != nil {
		t.Fatalf("create: %v", err)
	}

	runGitRaw(t, "--git-dir", paths.MirrorPath, "config", "remote.origin.url", "https://github.com/ankye/other.git")
	if _, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("another repository's URL = %v", err)
	}
	runGitRaw(t, "--git-dir", paths.MirrorPath, "config", "remote.origin.url", "https://github.com/ankye/dshker.git")

	runGitRaw(t, "--git-dir", paths.MirrorPath, "remote", "add", "upstream", "https://github.com/ankye/other.git")
	if _, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("a second remote = %v", err)
	}
	runGitRaw(t, "--git-dir", paths.MirrorPath, "remote", "remove", "upstream")

	runGitRaw(t, "--git-dir", paths.MirrorPath, "config", "remote.origin.pushurl", "https://github.com/ankye/other.git")
	if _, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("a push-only URL = %v", err)
	}
	runGitRaw(t, "--git-dir", paths.MirrorPath, "config", "--unset", "remote.origin.pushurl")

	runGitRaw(t, "--git-dir", paths.MirrorPath, "config", "url.https://evil.example/.insteadOf", "https://github.com/")
	if _, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("a local URL rewrite = %v", err)
	}
	runGitRaw(t, "--git-dir", paths.MirrorPath, "config", "--remove-section", "url.https://evil.example/")

	if _, err := InspectMirror(context.Background(), runner, executable, execution, paths, expectedOrigin(t)); err != nil {
		t.Fatalf("a restored mirror = %v", err)
	}
	// A non-bare git directory is the case git answers about: it is a repository,
	// and it is not bare. A worktree root is not a git directory at all, so the
	// proof fails at the command rather than at the state — which is what the
	// shell did too, and why the state rule is the narrower one.
	nonBare := filepath.Join(repository, ".git")
	if err := VerifyBareMirror(context.Background(), runner, executable, execution, nonBare, expectedOrigin(t)); !errors.Is(err, ErrRepositoryNotBare) {
		t.Fatalf("a non-bare git directory = %v", err)
	}
	if err := VerifyBareMirror(context.Background(), runner, executable, execution, repository, expectedOrigin(t)); !errors.Is(err, ErrCommandFailed) {
		t.Fatalf("a worktree instead of a mirror = %v", err)
	}
}
