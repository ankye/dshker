package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/ankye/dshker/networking/internal/gitcheckout"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// The core owns Harness checkout management (task 4.2): the shell asks for one
// operation and receives a verified identity it can persist. Every refusal that
// leaves here is one of the three renderer codes the page already maps --
// managed.git_remote_invalid, managed.git_revision_invalid and
// managed.git_operation_failed -- because the shell's own git.* codes are
// internal to this composition.

// gitRegistration is one pinned git executable as the installation catalog
// stores it. A checkout verifies it before running anything, so the core can
// never be pointed at a different binary than the one that was registered.
type gitRegistration struct {
	RequestedPath string                  `json:"requestedPath"`
	CanonicalPath string                  `json:"canonicalPath"`
	Fingerprint   gitcheckout.Fingerprint `json:"fingerprint"`
	Version       gitcheckout.Version     `json:"version"`
}

func (registration gitRegistration) executable() gitcheckout.Executable {
	return gitcheckout.Executable{
		RequestedPath: registration.RequestedPath,
		CanonicalPath: registration.CanonicalPath,
		Fingerprint:   registration.Fingerprint,
		Version:       registration.Version,
	}
}

type gitRegisterRequest struct {
	ExecutablePath   string              `json:"executablePath"`
	WorkingDirectory string              `json:"workingDirectory"`
	Minimum          gitcheckout.Version `json:"minimum"`
	MaximumExclusive gitcheckout.Version `json:"maximumExclusive"`
}

type gitRegisterResult struct {
	Registration gitRegistration `json:"registration"`
}

type repositoryInspectRequest struct {
	RepositoryPath string                  `json:"repositoryPath"`
	Remote         gitcheckout.NamedRemote `json:"remote"`
	Git            gitRegistration         `json:"git"`
}

type repositoryInspectResult struct {
	Inspection gitcheckout.RepositoryInspection `json:"inspection"`
}

type checkoutRequest struct {
	NamespacePath  string                  `json:"namespacePath"`
	InstallationID string                  `json:"installationId"`
	Remote         gitcheckout.NamedRemote `json:"remote"`
	Git            gitRegistration         `json:"git"`
	BundlePath     string                  `json:"bundlePath"`
	Selection      gitcheckout.Selection   `json:"selection"`
}

type checkoutVerifyRequest struct {
	NamespacePath  string                  `json:"namespacePath"`
	InstallationID string                  `json:"installationId"`
	Remote         gitcheckout.NamedRemote `json:"remote"`
	Git            gitRegistration         `json:"git"`
	Commit         string                  `json:"commit"`
}

// checkoutResult is what the shell persists: the verified identity, with the
// paths the core derived itself rather than paths the shell proposed.
type checkoutResult struct {
	InstallationPath  string                  `json:"installationPath"`
	MirrorPath        string                  `json:"mirrorPath"`
	WorktreePath      string                  `json:"worktreePath"`
	Commit            string                  `json:"commit"`
	Remote            gitcheckout.NamedRemote `json:"remote"`
	Selection         gitcheckout.Selection   `json:"selection"`
	ObservedReference string                  `json:"observedReference"`
	ObservedObject    string                  `json:"observedObject"`
}

// checkoutRefusal translates one checkout failure into the code the renderer
// already maps, so no git.* code ever reaches the page.
func checkoutRefusal(err error) error {
	code := gitcheckout.RendererCode(err)
	if code == "" {
		code = gitcheckout.CodeOperationFailed
	}
	return fmt.Errorf("%s: %s", code, err.Error())
}

// gitExecutionContext is the explicit context every core-owned git invocation
// runs under: the closed environment of the shell's rules, a bounded output and
// a bounded timeout. Nothing is inherited from the ambient environment except the
// Windows process variables a direct executable needs, and those are registered
// here rather than passed through.
func gitExecutionContext(workingDirectory string) (gitcheckout.ExecutionContext, error) {
	environment, err := gitcheckout.CreateExecutionEnvironment(
		runtime.GOOS,
		os.Getenv("SYSTEMROOT"),
		os.Getenv("WINDIR"),
		os.Getenv("COMSPEC"),
		os.Getenv("PATHEXT"),
	)
	if err != nil {
		return gitcheckout.ExecutionContext{}, err
	}
	return gitcheckout.ExecutionContext{
		WorkingDirectory:    workingDirectory,
		Environment:         environment,
		TimeoutMilliseconds: 300_000,
		MaximumOutputBytes:  4 * 1024 * 1024,
	}, nil
}

// handleGitRegister pins the selected git, asks it for its version and applies
// the declared policy, in that order.
func (server Serve) handleGitRegister(ctx context.Context, payload json.RawMessage) (any, error) {
	var request gitRegisterRequest
	if err := protocol.Decode(payload, &request); err != nil {
		return nil, err
	}
	execution, err := gitExecutionContext(request.WorkingDirectory)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	registration, err := gitcheckout.RegisterExecutable(ctx, request.ExecutablePath, execution, gitcheckout.VersionPolicy{
		Minimum:          request.Minimum,
		MaximumExclusive: request.MaximumExclusive,
	})
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	return gitRegisterResult{Registration: gitRegistration{
		RequestedPath: registration.RequestedPath,
		CanonicalPath: registration.CanonicalPath,
		Fingerprint:   registration.Fingerprint,
		Version:       registration.Version,
	}}, nil
}

// handleRepositoryInspect observes a user-owned checkout read-only, so a user can
// be shown what the launcher found before anything is created.
func (server Serve) handleRepositoryInspect(ctx context.Context, payload json.RawMessage) (any, error) {
	var request repositoryInspectRequest
	if err := protocol.Decode(payload, &request); err != nil {
		return nil, err
	}
	execution, err := gitExecutionContext(filepath.Dir(request.RepositoryPath))
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	executable := request.Git.executable()
	if err := gitcheckout.AssertExecutable(executable); err != nil {
		return nil, checkoutRefusal(err)
	}
	inspection, err := gitcheckout.InspectRepository(ctx, gitcheckout.NewRunner(), executable, execution, request.RepositoryPath, request.Remote)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	return repositoryInspectResult{Inspection: inspection}, nil
}

// handleCheckoutPrepare brings one installation to a verified worktree: the
// mirror is created from the declared URL or imported from a verified bundle if
// it is not there yet, the selection is resolved against it, and the worktree for
// that exact commit is materialized and verified. Persisting the answer is the
// shell's job; deciding what the answer is, is not.
func (server Serve) handleCheckoutPrepare(ctx context.Context, payload json.RawMessage) (any, error) {
	var request checkoutRequest
	if err := protocol.Decode(payload, &request); err != nil {
		return nil, err
	}
	paths, err := gitcheckout.NewInstallationPaths(request.NamespacePath, request.InstallationID)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	execution, err := gitExecutionContext(request.NamespacePath)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	executable := request.Git.executable()
	if err := gitcheckout.AssertExecutable(executable); err != nil {
		return nil, checkoutRefusal(err)
	}
	runner := gitcheckout.NewRunner()
	if err := ensureMirror(ctx, runner, executable, execution, paths, request.Remote, request.BundlePath); err != nil {
		return nil, checkoutRefusal(err)
	}
	resolved, err := gitcheckout.ResolveRevision(ctx, runner, executable, execution, paths, request.Remote, request.Selection)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	worktree, err := gitcheckout.MaterializeWorktree(ctx, runner, executable, execution, paths, request.Remote, resolved.Commit)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	return checkoutResult{
		InstallationPath:  paths.InstallationPath,
		MirrorPath:        paths.MirrorPath,
		WorktreePath:      worktree.Path,
		Commit:            resolved.Commit,
		Remote:            request.Remote,
		Selection:         resolved.Selection,
		ObservedReference: resolved.ObservedReference,
		ObservedObject:    resolved.ObservedObject,
	}, nil
}

// ensureMirror creates or refreshes the installation's mirror without ever
// overwriting one that is already published.
func ensureMirror(ctx context.Context, runner *gitcheckout.Runner, executable gitcheckout.Executable, execution gitcheckout.ExecutionContext, paths gitcheckout.InstallationPaths, remote gitcheckout.NamedRemote, bundlePath string) error {
	if _, err := os.Lstat(paths.MirrorPath); err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		if bundlePath != "" {
			_, err = gitcheckout.CreateMirrorFromBundle(ctx, runner, executable, execution, paths, remote, bundlePath)
			return err
		}
		_, err = gitcheckout.CreateMirror(ctx, runner, executable, execution, paths, remote)
		return err
	}
	_, err := gitcheckout.FetchMirror(ctx, runner, executable, execution, paths, remote)
	return err
}

// handleCheckoutVerify re-reads an installation's worktree without changing it:
// the mirror, the worktree identity, the remote and the cleanliness of the tree.
func (server Serve) handleCheckoutVerify(ctx context.Context, payload json.RawMessage) (any, error) {
	var request checkoutVerifyRequest
	if err := protocol.Decode(payload, &request); err != nil {
		return nil, err
	}
	paths, err := gitcheckout.NewInstallationPaths(request.NamespacePath, request.InstallationID)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	execution, err := gitExecutionContext(request.NamespacePath)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	executable := request.Git.executable()
	if err := gitcheckout.AssertExecutable(executable); err != nil {
		return nil, checkoutRefusal(err)
	}
	worktree, err := gitcheckout.VerifyWorktree(ctx, gitcheckout.NewRunner(), executable, execution, paths, request.Remote, request.Commit)
	if err != nil {
		return nil, checkoutRefusal(err)
	}
	return checkoutResult{
		InstallationPath: paths.InstallationPath,
		MirrorPath:       paths.MirrorPath,
		WorktreePath:     worktree.Path,
		Commit:           worktree.Commit,
		Remote:           request.Remote,
	}, nil
}
