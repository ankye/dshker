package gitcheckout

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// Worktree is the readback identity of one verified detached managed worktree.
type Worktree struct {
	Path   string      `json:"path"`
	Commit string      `json:"commit"`
	Remote NamedRemote `json:"remote"`
}

// MaterializeWorktree creates one detached worktree for an exact resolved commit.
// The path is the commit itself, so a worktree can only ever exist for the commit
// it was created from, and it is never reused for another one.
func MaterializeWorktree(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote, commit string) (Worktree, error) {
	if _, err := ParseCommitSHA(commit); err != nil {
		return Worktree{}, err
	}
	lock, err := AcquireOperationLock(paths)
	if err != nil {
		return Worktree{}, err
	}
	defer func() {
		_ = lock.Release()
	}()
	// The mirror is verified before it is asked to create anything: a mirror that
	// no longer fetches from the confirmed URL must not be built on.
	if _, err = InspectMirror(ctx, runner, executable, context, paths, remote); err != nil {
		return Worktree{}, err
	}
	target, err := ManagedWorktreePath(paths, commit)
	if err != nil {
		return Worktree{}, err
	}
	if err = assertWorktreeAbsent(target); err != nil {
		return Worktree{}, err
	}
	if _, err = RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.materialize_detached_worktree",
		Arguments: []string{"--git-dir", paths.MirrorPath, "worktree", "add", "--detach", target, commit},
	}); err != nil {
		return Worktree{}, err
	}
	return VerifyWorktree(ctx, runner, executable, context, paths, remote, commit)
}

// VerifyWorktree re-reads every runtime-relevant identity of a managed worktree
// without changing its checkout state: the path is the worktree the launcher
// registered, HEAD is the selected commit, the worktree belongs to this
// installation's mirror, the remote is still the confirmed one, and the working
// tree is clean.
func VerifyWorktree(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote, expectedCommit string) (Worktree, error) {
	if _, err := ParseCommitSHA(expectedCommit); err != nil {
		return Worktree{}, err
	}
	if err := AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		return Worktree{}, err
	}
	worktreePath, err := ManagedWorktreePath(paths, expectedCommit)
	if err != nil {
		return Worktree{}, err
	}
	if err = AssertManagedTarget(paths, worktreePath, "Managed Git worktree"); err != nil {
		return Worktree{}, err
	}
	if err = VerifyBareMirror(ctx, runner, executable, context, paths.MirrorPath, remote); err != nil {
		return Worktree{}, err
	}

	topLevel, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.read_worktree_top_level",
		Arguments: []string{"-C", worktreePath, "rev-parse", "--show-toplevel"},
	})
	if err != nil {
		return Worktree{}, err
	}
	head, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.read_worktree_head",
		Arguments: []string{"-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"},
	})
	if err != nil {
		return Worktree{}, err
	}
	commonDirectory, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.read_worktree_common_directory",
		Arguments: []string{"-C", worktreePath, "rev-parse", "--git-common-dir"},
	})
	if err != nil {
		return Worktree{}, err
	}
	observedRemote, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.read_worktree_remote",
		Arguments: []string{"-C", worktreePath, "remote", "get-url", remote.Name},
	})
	if err != nil {
		return Worktree{}, err
	}

	observedTopLevel, err := RequireSingleGitLine(topLevel.Stdout, "Managed worktree top-level")
	if err != nil {
		return Worktree{}, err
	}
	if !SameRegisteredPath(observedTopLevel, worktreePath) {
		return Worktree{}, fmt.Errorf("%w: Managed Git worktree top-level differs from its registered path.", ErrWorktreeMismatch)
	}
	observedHead, err := RequireSingleGitLine(head.Stdout, "Managed worktree HEAD")
	if err != nil {
		return Worktree{}, err
	}
	observedCommit, err := ParseCommitSHA(observedHead)
	if err != nil {
		return Worktree{}, err
	}
	if observedCommit != expectedCommit {
		return Worktree{}, fmt.Errorf("%w: Managed Git worktree HEAD differs from the selected commit (expected %s, observed %s).", ErrWorktreeMismatch, expectedCommit, observedCommit)
	}
	commonDirectoryValue, err := RequireSingleGitLine(commonDirectory.Stdout, "Managed worktree common directory")
	if err != nil {
		return Worktree{}, err
	}
	commonDirectoryPath := commonDirectoryValue
	if !filepath.IsAbs(commonDirectoryPath) {
		commonDirectoryPath = filepath.Join(worktreePath, commonDirectoryPath)
	}
	canonicalCommonDirectory, err := filepath.EvalSymlinks(commonDirectoryPath)
	if err != nil {
		return Worktree{}, fmt.Errorf("%w: Managed Git worktree common directory is unavailable.", ErrWorktreeMismatch)
	}
	if !SameRegisteredPath(canonicalCommonDirectory, paths.MirrorPath) {
		return Worktree{}, fmt.Errorf("%w: Managed Git worktree belongs to a different mirror.", ErrWorktreeMismatch)
	}
	observedRemoteValue, err := RequireSingleGitLine(observedRemote.Stdout, "Managed worktree remote")
	if err != nil {
		return Worktree{}, err
	}
	observedSource, err := ParseSource(observedRemoteValue)
	if err != nil {
		return Worktree{}, err
	}
	if err = AssertIdentity(remote.Source.Identity, observedSource.Identity); err != nil {
		return Worktree{}, err
	}
	if err = AssertWorktreeClean(ctx, runner, executable, context, worktreePath); err != nil {
		return Worktree{}, err
	}
	return Worktree{Path: worktreePath, Commit: expectedCommit, Remote: remote}, nil
}

// AssertWorktreeClean refuses a worktree with any changed or untracked content: a
// user's uncommitted work is never something the launcher may switch away from.
func AssertWorktreeClean(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, worktreePath string) error {
	result, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.inspect_worktree_cleanliness",
		Arguments: []string{
			"-C", worktreePath,
			"status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
		},
	})
	if err != nil {
		return err
	}
	entries := nonEmptyLines(result.Stdout)
	if len(entries) > 0 {
		return fmt.Errorf("%w: Managed Git worktree contains %d change(s) and cannot be activated (first: %s).", ErrRepositoryDirty, len(entries), entries[0])
	}
	return nil
}

// assertWorktreeAbsent refuses to build a worktree where one already exists.
func assertWorktreeAbsent(path string) error {
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%w: Managed Git worktree path could not be inspected.", ErrOperationFailed)
	}
	return fmt.Errorf("%w: Managed Git worktree already exists for the selected commit.", ErrWorktreeExists)
}
