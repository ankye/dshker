// Package gitcheckout owns the managed Harness checkout: which remote URLs may
// ever be handed to git, which revision selections are well formed, the mirror
// and worktree layout below a workspace, and the git invocations that prepare
// them.
//
// It is the Go half of electron/main/managed/git/. The rules are ported rather
// than reinterpreted, because they are what keeps a credential out of a remote
// URL, a local path out of a clone, an ambient environment out of a git process,
// and an abbreviated object id from being resolved to something else.
//
// The failure codes here are the shell's own git.* ones. They are deliberately
// NOT in protocol.RefusalFamilies: the renderer never sees them. The core
// translates them to the three codes the page already maps (see RendererCode) at
// the channel boundary, exactly where
// electron/main/managed/installation-service.ts does it today.
package gitcheckout

import "errors"

// The refusals this package reports, spelled as the shell's git layer spells
// them. A caller that needs a renderer-visible code translates them with
// RendererCode; nothing else should need to know these strings.
var (
	ErrExecutableInvalid     = errors.New("git.executable_invalid")
	ErrExecutableChanged     = errors.New("git.executable_changed")
	ErrExecutableUnavailable = errors.New("git.executable_unavailable")
	ErrVersionInvalid        = errors.New("git.version_invalid")
	ErrVersionUnsupported    = errors.New("git.version_unsupported")
	ErrCommandInvalid        = errors.New("git.command_invalid")
	ErrCommandTimeout        = errors.New("git.command_timeout")
	ErrCommandCancelled      = errors.New("git.command_cancelled")
	ErrCommandOutputLimit    = errors.New("git.command_output_limit")
	ErrCommandFailed         = errors.New("git.command_failed")
	ErrRemoteInvalid         = errors.New("git.remote_invalid")
	ErrRemoteMismatch        = errors.New("git.remote_mismatch")
	ErrRemoteMissing         = errors.New("git.remote_missing")
	ErrRepositoryInvalid     = errors.New("git.repository_invalid")
	ErrRepositoryNotBare     = errors.New("git.repository_not_bare")
	ErrRepositoryDirty       = errors.New("git.repository_dirty")
	ErrRefInvalid            = errors.New("git.ref_invalid")
	ErrRefMissing            = errors.New("git.ref_missing")
	ErrRefAmbiguous          = errors.New("git.ref_ambiguous")
	ErrRefNotCommit          = errors.New("git.ref_not_commit")
	ErrRefRewritten          = errors.New("git.ref_rewritten")
	ErrManagedPathInvalid    = errors.New("git.managed_path_invalid")
	ErrManagedPathEscape     = errors.New("git.managed_path_escape")
	ErrMirrorExists          = errors.New("git.mirror_exists")
	ErrMirrorMissing         = errors.New("git.mirror_missing")
	ErrWorktreeExists        = errors.New("git.worktree_exists")
	ErrWorktreeMissing       = errors.New("git.worktree_missing")
	ErrWorktreeMismatch      = errors.New("git.worktree_mismatch")
	ErrOperationLocked       = errors.New("git.operation_locked")
	ErrOperationLockLost     = errors.New("git.operation_lock_lost")
	ErrOperationFailed       = errors.New("git.operation_failed")
)
