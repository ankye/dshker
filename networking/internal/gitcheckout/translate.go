package gitcheckout

import "errors"

// The three codes the renderer already maps for managed Git work. They are the
// only ones a checkout failure may cross the private channel with: the git.*
// codes this package reports are internal, and a shell bug that let one through
// would reach the page as p2p.operation_failed.
const (
	// CodeRemoteInvalid names a remote the launcher will not use.
	CodeRemoteInvalid = "managed.git_remote_invalid"
	// CodeRevisionInvalid names a branch, tag or commit selection it will not use.
	CodeRevisionInvalid = "managed.git_revision_invalid"
	// CodeOperationFailed names every other checkout failure.
	CodeOperationFailed = "managed.git_operation_failed"
)

// RendererCode translates one failure from this package into the code the page
// already maps, so the wire contract is unchanged by the port.
//
// The two validation stages are the translation's whole point: the shell reports
// managed.git_remote_invalid when a remote is refused and
// managed.git_revision_invalid when a selection is
// (electron/main/managed/installation-service.ts), and every deeper failure —
// an inspection, a fetch, a worktree — reaches the page as
// managed.git_operation_failed (electron/main/ipc.ts). A caller that already
// knows which stage it is in may pass the code directly instead.
func RendererCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrRemoteInvalid):
		return CodeRemoteInvalid
	case errors.Is(err, ErrRefInvalid):
		return CodeRevisionInvalid
	default:
		return CodeOperationFailed
	}
}
