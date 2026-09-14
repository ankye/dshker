package gitcheckout

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RepositoryInspection is the read-only observation of a user-owned repository.
type RepositoryInspection struct {
	CanonicalPath string   `json:"canonicalPath"`
	Head          string   `json:"head"`
	Remote        Identity `json:"remote"`
	DirtyEntries  []string `json:"dirtyEntries"`
}

// InspectRepository observes an explicitly selected user-owned checkout without
// running a single state-changing git command. Every rule it applies is a refusal
// rather than a repair: the path has to be the worktree root the user selected,
// the named remote has to be the one that was confirmed, and the HEAD has to be a
// commit rather than a branch name.
func InspectRepository(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, repositoryPath string, expectedRemote NamedRemote) (RepositoryInspection, error) {
	if err := AssertNamedRemote(expectedRemote); err != nil {
		return RepositoryInspection{}, err
	}
	if err := assertExternalRepositoryPath(repositoryPath); err != nil {
		return RepositoryInspection{}, err
	}
	topLevel, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.inspect_unmanaged_top_level",
		Arguments: []string{"-C", repositoryPath, "rev-parse", "--show-toplevel"},
	})
	if err != nil {
		return RepositoryInspection{}, err
	}
	if topLevel.ExitCode == nil || *topLevel.ExitCode != 0 {
		return RepositoryInspection{}, fmt.Errorf("%w: Selected path is not an inspectable Git worktree.", ErrRepositoryInvalid)
	}
	observedTopLevel, err := RequireSingleGitLine(topLevel.Stdout, "Unmanaged repository top-level")
	if err != nil {
		return RepositoryInspection{}, err
	}
	if !SameRegisteredPath(observedTopLevel, repositoryPath) {
		return RepositoryInspection{}, fmt.Errorf("%w: Selected path is not the Git worktree root.", ErrRepositoryInvalid)
	}
	inside, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.inspect_unmanaged_inside_work_tree",
		Arguments: []string{"-C", repositoryPath, "rev-parse", "--is-inside-work-tree"},
	})
	if err != nil {
		return RepositoryInspection{}, err
	}
	insideLine, err := RequireSingleGitLine(inside.Stdout, "Unmanaged worktree state")
	if err != nil {
		return RepositoryInspection{}, err
	}
	if insideLine != "true" {
		return RepositoryInspection{}, fmt.Errorf("%w: Selected path is not a Git worktree.", ErrRepositoryInvalid)
	}

	// The three observations are taken one after another rather than together, so
	// that a repository failing more than one of them always reports the same one:
	// the HEAD first, then the remote, then the working tree. The shell issued them
	// together and reported whichever failed first in time.
	head, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.inspect_unmanaged_head",
		Arguments: []string{"-C", repositoryPath, "rev-parse", "--verify", "HEAD^{commit}"},
	})
	if err != nil {
		return RepositoryInspection{}, err
	}
	observedHead, err := RequireSingleGitLine(head.Stdout, "Unmanaged repository HEAD")
	if err != nil {
		return RepositoryInspection{}, err
	}
	commit, err := ParseCommitSHA(observedHead)
	if err != nil {
		return RepositoryInspection{}, err
	}
	remote, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.inspect_unmanaged_remote",
		Arguments: []string{"-C", repositoryPath, "remote", "get-url", expectedRemote.Name},
	})
	if err != nil {
		return RepositoryInspection{}, err
	}
	if remote.ExitCode == nil || *remote.ExitCode != 0 {
		return RepositoryInspection{}, fmt.Errorf("%w: Selected repository does not expose the expected named remote (%s).", ErrRemoteMissing, expectedRemote.Name)
	}
	observedRemoteValue, err := RequireSingleGitLine(remote.Stdout, "Unmanaged repository remote")
	if err != nil {
		return RepositoryInspection{}, err
	}
	observedRemote, err := ParseSource(observedRemoteValue)
	if err != nil {
		return RepositoryInspection{}, err
	}
	if err = AssertIdentity(expectedRemote.Source.Identity, observedRemote.Identity); err != nil {
		return RepositoryInspection{}, err
	}
	status, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.inspect_unmanaged_status",
		Arguments: []string{
			"-C", repositoryPath,
			"status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
		},
	})
	if err != nil {
		return RepositoryInspection{}, err
	}
	return RepositoryInspection{
		CanonicalPath: repositoryPath,
		Head:          commit,
		Remote:        observedRemote.Identity,
		DirtyEntries:  dirtyEntriesOf(status.Stdout),
	}, nil
}

// dirtyEntriesOf lists the entries git reported, one per line, without the
// porcelain prefix being interpreted: a caller needs to know whether there is
// anything at all, and what it was called.
func dirtyEntriesOf(stdout string) []string {
	entries := make([]string, 0)
	for _, line := range strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n") {
		if line != "" {
			entries = append(entries, line)
		}
	}
	return entries
}

// assertExternalRepositoryPath refuses anything but a canonical, non-symlink,
// existing directory that is not a filesystem root: a repository the launcher
// observes is a directory a user selected, and a link there would make the
// observation describe somewhere else.
func assertExternalRepositoryPath(path string) error {
	if err := AssertCanonicalAbsolutePath(path, "Selected repository path", ErrRepositoryInvalid); err != nil {
		return err
	}
	metadata, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("%w: Selected repository path cannot be inspected.", ErrRepositoryInvalid)
	}
	canonicalPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("%w: Selected repository path cannot be inspected.", ErrRepositoryInvalid)
	}
	if !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 || canonicalPath != path {
		return fmt.Errorf("%w: Selected repository path must be a canonical non-symbolic directory.", ErrRepositoryInvalid)
	}
	return nil
}
