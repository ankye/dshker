// Package gitcheckout owns the managed Harness checkout: which remote URLs may
// ever be handed to git, which revision selections are well formed, the mirror
// and worktree layout below a workspace, and the git invocations that prepare
// them.
//
// It is the Go half of electron/main/managed/git/. The first half landed here,
// and it is the input-validation half: the exact rules that decide what may
// reach git at all (remote.ts) and what a branch, tag or commit selection is
// (revision.ts). The rules are ported rather than reinterpreted, because they are
// what keeps a credential out of a remote URL, a local path out of a clone, and
// an abbreviated object id from being resolved to something else.
//
// The failure codes here are the shell's own git.* ones. They are deliberately
// NOT in protocol.RefusalFamilies: the renderer never sees them. The core
// translates them to the three codes the page already maps — managed.git_remote_invalid,
// managed.git_revision_invalid and managed.git_operation_failed — at the channel
// boundary, exactly where electron/main/managed/installation-service.ts does it
// today.
package gitcheckout

import "errors"

// The refusals this package reports, spelled as the shell's git layer spells
// them. A caller that needs a renderer-visible code translates them; nothing else
// should need to know these strings.
var (
	// ErrRemoteInvalid rejects a remote name or URL the launcher will not use.
	ErrRemoteInvalid = errors.New("git.remote_invalid")
	// ErrRemoteMismatch rejects an observed remote that is not the selected one.
	ErrRemoteMismatch = errors.New("git.remote_mismatch")
	// ErrRevisionInvalid rejects a branch, tag or commit selection.
	ErrRevisionInvalid = errors.New("git.ref_invalid")
	// ErrRefNotCommit rejects a commit that did not resolve to itself.
	ErrRefNotCommit = errors.New("git.ref_not_commit")
	// ErrRefRewritten rejects a mutable reference that moved incompatibly.
	ErrRefRewritten = errors.New("git.ref_rewritten")
)
