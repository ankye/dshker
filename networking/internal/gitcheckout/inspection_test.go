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

// gitFixture creates a real repository, because inspection is a conversation with
// git and a fake would only prove that the fake answers.
func gitFixture(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed on this machine")
	}
	directory := canonicalDirectory(t)
	runGit(t, directory, "init", "--quiet")
	runGit(t, directory, "-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--allow-empty", "--quiet", "-m", "initial")
	runGit(t, directory, "remote", "add", "origin", "https://github.com/ankye/dshker.git")
	return directory, strings.TrimSpace(runGit(t, directory, "rev-parse", "HEAD"))
}

func runGit(t *testing.T, directory string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, arguments...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=0")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(arguments, " "), err, output)
	}
	return string(output)
}

func inspect(t *testing.T, directory string, remote NamedRemote) (RepositoryInspection, error) {
	t.Helper()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed on this machine")
	}
	gitPath, err = filepath.EvalSymlinks(gitPath)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := PinExecutable(gitPath)
	if err != nil {
		t.Fatal(err)
	}
	return InspectRepository(context.Background(), NewRunner(), executable, executionContext(t, directory), directory, remote)
}

func expectedOrigin(t *testing.T) NamedRemote {
	t.Helper()
	remote, err := CreateNamedRemote("origin", "https://github.com/ankye/dshker.git")
	if err != nil {
		t.Fatal(err)
	}
	return remote
}

func TestInspectRepositoryObservesAUserCheckout(t *testing.T) {
	directory, head := gitFixture(t)
	inspection, err := inspect(t, directory, expectedOrigin(t))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspection.CanonicalPath != directory || inspection.Head != head {
		t.Fatalf("inspection = %+v", inspection)
	}
	if inspection.Remote.Host != "github.com" || inspection.Remote.RepositoryPath != "ankye/dshker.git" {
		t.Fatalf("remote = %+v", inspection.Remote)
	}
	if len(inspection.DirtyEntries) != 0 {
		t.Fatalf("a clean checkout reported %v", inspection.DirtyEntries)
	}

	if err = os.WriteFile(filepath.Join(directory, "notes.txt"), []byte("draft\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dirty, err := inspect(t, directory, expectedOrigin(t))
	if err != nil {
		t.Fatalf("inspect a dirty checkout: %v", err)
	}
	if len(dirty.DirtyEntries) != 1 || !strings.Contains(dirty.DirtyEntries[0], "notes.txt") {
		t.Fatalf("dirty entries = %v", dirty.DirtyEntries)
	}
}

func TestInspectRepositoryRefusesTheWrongOrMissingRemote(t *testing.T) {
	directory, _ := gitFixture(t)

	other, err := CreateNamedRemote("origin", "https://github.com/ankye/other.git")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = inspect(t, directory, other); !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("a different repository = %v", err)
	}

	missing, err := CreateNamedRemote("upstream", "https://github.com/ankye/dshker.git")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = inspect(t, directory, missing); !errors.Is(err, ErrRemoteMissing) {
		t.Fatalf("a remote that is not configured = %v", err)
	}

	if _, err = CreateNamedRemote("origin", "/srv/git/repo"); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("a local path as the expected remote = %v", err)
	}
}

func TestInspectRepositoryRefusesWhatIsNotTheSelectedRoot(t *testing.T) {
	directory, _ := gitFixture(t)

	subdirectory := filepath.Join(directory, "nested")
	if err := os.Mkdir(subdirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := inspect(t, subdirectory, expectedOrigin(t)); !errors.Is(err, ErrRepositoryInvalid) {
		t.Fatalf("a subdirectory of a worktree = %v", err)
	}

	plain := canonicalDirectory(t)
	if _, err := inspect(t, plain, expectedOrigin(t)); !errors.Is(err, ErrRepositoryInvalid) {
		t.Fatalf("a directory that is not a repository = %v", err)
	}

	for _, path := range []string{"", "relative/path", string(filepath.Separator), directory + string(filepath.Separator)} {
		if _, err := inspect(t, path, expectedOrigin(t)); !errors.Is(err, ErrRepositoryInvalid) {
			t.Errorf("inspect(%q) = %v", path, err)
		}
	}

	link := filepath.Join(canonicalDirectory(t), "repository-link")
	if err := os.Symlink(directory, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, err := inspect(t, link, expectedOrigin(t)); !errors.Is(err, ErrRepositoryInvalid) {
		t.Fatalf("a symlinked repository path = %v", err)
	}
}

// TestCommandHelpers covers the three ways a git answer is read: exactly one
// line, a reference that may be missing, and a predicate that may be false.
func TestCommandHelpers(t *testing.T) {
	if line, err := RequireSingleGitLine("abc\n", "subject"); err != nil || line != "abc" {
		t.Fatalf("one line = %q, %v", line, err)
	}
	if line, err := RequireSingleGitLine("abc\r\n", "subject"); err != nil || line != "abc" {
		t.Fatalf("one CRLF line = %q, %v", line, err)
	}
	// Trailing blank lines are what git prints; they are not a second answer.
	if line, err := RequireSingleGitLine("a\n\n", "subject"); err != nil || line != "a" {
		t.Fatalf("a line with trailing blanks = %q, %v", line, err)
	}
	for _, value := range []string{"", "\n", "a\nb\n"} {
		if _, err := RequireSingleGitLine(value, "subject"); !errors.Is(err, ErrRefAmbiguous) {
			t.Errorf("RequireSingleGitLine(%q) = %v", value, err)
		}
	}

	for _, code := range []int{1, 128} {
		exit := code
		if _, err := RequireGitReferenceCommand(Result{Operation: "git.test", ExitCode: &exit}, "Branch"); !errors.Is(err, ErrRefMissing) {
			t.Errorf("exit %d = %v", code, err)
		}
	}
	zero, other := 0, 2
	if _, err := RequireGitReferenceCommand(Result{Operation: "git.test", ExitCode: &zero}, "Branch"); err != nil {
		t.Fatalf("exit 0 = %v", err)
	}
	if _, err := RequireGitReferenceCommand(Result{Operation: "git.test", ExitCode: &other}, "Branch"); !errors.Is(err, ErrCommandFailed) {
		t.Fatalf("exit 2 = %v", err)
	}

	one := 1
	if isAncestor, err := IsGitAncestryResult(Result{Operation: "git.test", ExitCode: &zero}); err != nil || !isAncestor {
		t.Fatalf("ancestry true = %v, %v", isAncestor, err)
	}
	if isAncestor, err := IsGitAncestryResult(Result{Operation: "git.test", ExitCode: &one}); err != nil || isAncestor {
		t.Fatalf("ancestry false = %v, %v", isAncestor, err)
	}
	if _, err := IsGitAncestryResult(Result{Operation: "git.test", ExitCode: &other}); !errors.Is(err, ErrCommandFailed) {
		t.Fatalf("ancestry failure = %v", err)
	}
}
