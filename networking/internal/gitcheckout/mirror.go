package gitcheckout

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Mirror is the readback identity of a verified launcher-owned bare mirror.
type Mirror struct {
	Path   string      `json:"path"`
	Remote NamedRemote `json:"remote"`
}

// rewritePatterns are the local configuration that could make a mirror fetch from
// somewhere other than the URL that was confirmed: a URL rewrite, and an include
// that could pull one in from a file outside the mirror.
var rewritePatterns = []string{`^url\..*\.insteadOf$`, `^include\.`}

// CreateMirror creates a new bare mirror through a private staging path and one
// atomic publication rename, so a reader never observes a half-built mirror.
func CreateMirror(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote) (Mirror, error) {
	return createMirror(ctx, runner, executable, context, paths, remote, "")
}

// CreateMirrorFromBundle imports one previously verified bundle into a fresh
// managed mirror without persisting the bundle as a git remote. Branches are
// written straight into the remote-tracking namespace, so resolving a revision
// afterwards is identical to a mirror created from the declared network remote.
func CreateMirrorFromBundle(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote, bundlePath string) (Mirror, error) {
	if err := assertDirectRegularBundleFile(bundlePath); err != nil {
		return Mirror{}, err
	}
	return createMirror(ctx, runner, executable, context, paths, remote, bundlePath)
}

func createMirror(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote, bundlePath string) (Mirror, error) {
	if err := AssertNamedRemote(remote); err != nil {
		return Mirror{}, err
	}
	lock, err := AcquireOperationLock(paths)
	if err != nil {
		return Mirror{}, err
	}
	defer func() {
		_ = lock.Release()
	}()
	if err = EnsureInstallationDirectories(paths); err != nil {
		return Mirror{}, err
	}
	if err = assertPathAbsent(paths.MirrorPath, ErrMirrorExists, "Managed Git mirror already exists."); err != nil {
		return Mirror{}, err
	}
	stagingID, err := newOwnerID()
	if err != nil {
		return Mirror{}, fmt.Errorf("%w: Managed Git staging mirror could not be named.", ErrOperationFailed)
	}
	stagingMirrorPath := filepath.Join(paths.StagingPath, "mirror-"+stagingID+".git")
	if err = assertPathAbsent(stagingMirrorPath, ErrOperationFailed, "Managed Git staging mirror already exists."); err != nil {
		return Mirror{}, err
	}
	if err = assertSameFilesystem(paths.StagingPath, filepath.Dir(paths.MirrorPath)); err != nil {
		return Mirror{}, err
	}
	if _, err = RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.create_bare_mirror",
		Arguments: []string{"init", "--bare", stagingMirrorPath},
	}); err != nil {
		return Mirror{}, err
	}
	if bundlePath != "" {
		if _, err = RunRequiredGitCommand(ctx, runner, executable, context, Command{
			Operation: "git.import_bundle_objects",
			Arguments: []string{
				"--git-dir", stagingMirrorPath,
				"fetch", "--atomic", "--no-write-fetch-head", "--no-tags", "--",
				bundlePath,
				"+refs/heads/*:refs/remotes/" + remote.Name + "/*",
				"+refs/tags/*:refs/tags/*",
			},
		}); err != nil {
			return Mirror{}, err
		}
	}
	if _, err = RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.add_mirror_remote",
		Arguments: []string{
			"--git-dir", stagingMirrorPath,
			"remote", "add", remote.Name, remote.Source.DeclaredURL,
		},
	}); err != nil {
		return Mirror{}, err
	}
	if bundlePath == "" {
		if err = fetchMirrorRemote(ctx, runner, executable, context, stagingMirrorPath, remote.Name); err != nil {
			return Mirror{}, err
		}
	}
	if err = VerifyBareMirror(ctx, runner, executable, context, stagingMirrorPath, remote); err != nil {
		return Mirror{}, err
	}
	if err = os.Rename(stagingMirrorPath, paths.MirrorPath); err != nil {
		return Mirror{}, fmt.Errorf("%w: Managed Git mirror could not be published atomically.", ErrOperationFailed)
	}
	if err = AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		return Mirror{}, err
	}
	if err = VerifyBareMirror(ctx, runner, executable, context, paths.MirrorPath, remote); err != nil {
		return Mirror{}, err
	}
	return Mirror{Path: paths.MirrorPath, Remote: remote}, nil
}

// FetchMirror fetches only the declared remote into an existing verified mirror.
func FetchMirror(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote) (Mirror, error) {
	if err := AssertNamedRemote(remote); err != nil {
		return Mirror{}, err
	}
	lock, err := AcquireOperationLock(paths)
	if err != nil {
		return Mirror{}, err
	}
	defer func() {
		_ = lock.Release()
	}()
	if err = AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		return Mirror{}, err
	}
	if err = VerifyBareMirror(ctx, runner, executable, context, paths.MirrorPath, remote); err != nil {
		return Mirror{}, err
	}
	// The fetch happens between two verifications: a mirror whose configuration was
	// changed after the first check would be caught by the second.
	if err = fetchMirrorRemote(ctx, runner, executable, context, paths.MirrorPath, remote.Name); err != nil {
		return Mirror{}, err
	}
	if err = VerifyBareMirror(ctx, runner, executable, context, paths.MirrorPath, remote); err != nil {
		return Mirror{}, err
	}
	return Mirror{Path: paths.MirrorPath, Remote: remote}, nil
}

// InspectMirror reads a managed mirror without fetching or changing anything.
func InspectMirror(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote) (Mirror, error) {
	if err := AssertNamedRemote(remote); err != nil {
		return Mirror{}, err
	}
	if err := AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		return Mirror{}, err
	}
	if err := VerifyBareMirror(ctx, runner, executable, context, paths.MirrorPath, remote); err != nil {
		return Mirror{}, err
	}
	return Mirror{Path: paths.MirrorPath, Remote: remote}, nil
}

// VerifyBareMirror verifies both the bare-repository state and the single remote
// identity the mirror is allowed to carry. A mirror is only usable if it is bare,
// has exactly the named remote, has one URL that is still the confirmed source,
// has no push-only URL, and carries no local configuration that could redirect it.
func VerifyBareMirror(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, mirrorPath string, remote NamedRemote) error {
	bare, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.verify_bare_mirror",
		Arguments: []string{"--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"},
	})
	if err != nil {
		return err
	}
	bareState, err := RequireSingleGitLine(bare.Stdout, "Bare mirror state")
	if err != nil {
		return err
	}
	if bareState != "true" {
		return fmt.Errorf("%w: Managed Git mirror is not a bare repository.", ErrRepositoryNotBare)
	}
	remoteNames, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.read_mirror_remote_names",
		Arguments: []string{"--git-dir", mirrorPath, "remote"},
	})
	if err != nil {
		return err
	}
	if names := nonEmptyLines(remoteNames.Stdout); len(names) != 1 || names[0] != remote.Name {
		return fmt.Errorf("%w: Managed Git mirror contains unexpected named remotes.", ErrRemoteMismatch)
	}
	remoteURLs, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.read_mirror_remote_url",
		Arguments: []string{"--git-dir", mirrorPath, "config", "--local", "--get-all", "remote." + remote.Name + ".url"},
	})
	if err != nil {
		return err
	}
	if remoteURLs.ExitCode == nil || *remoteURLs.ExitCode != 0 {
		return fmt.Errorf("%w: Managed Git mirror does not contain the selected remote.", ErrRemoteMissing)
	}
	urls := nonEmptyLines(remoteURLs.Stdout)
	if len(urls) != 1 {
		return fmt.Errorf("%w: Managed Git mirror has an ambiguous remote URL.", ErrRemoteMismatch)
	}
	remotePushURLs, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.read_mirror_remote_push_url",
		Arguments: []string{"--git-dir", mirrorPath, "config", "--local", "--get-all", "remote." + remote.Name + ".pushurl"},
	})
	if err != nil {
		return err
	}
	pushExit := -1
	if remotePushURLs.ExitCode != nil {
		pushExit = *remotePushURLs.ExitCode
	}
	if pushExit == 0 && strings.TrimSpace(remotePushURLs.Stdout) != "" {
		return fmt.Errorf("%w: Managed Git mirror must not configure a push-only remote URL.", ErrRemoteMismatch)
	}
	if pushExit != 0 && pushExit != 1 {
		return RequireSuccess(remotePushURLs)
	}
	if err = assertNoMirrorConfigurationRewrite(ctx, runner, executable, context, mirrorPath); err != nil {
		return err
	}
	observedSource, err := ParseSource(urls[0])
	if err != nil {
		return err
	}
	return AssertIdentity(remote.Source.Identity, observedSource.Identity)
}

// assertNoMirrorConfigurationRewrite refuses a local URL rewrite or include: both
// would let the mirror fetch from an address other than the one that was
// confirmed, which is the one thing the mirror's identity exists to prevent.
func assertNoMirrorConfigurationRewrite(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, mirrorPath string) error {
	for _, pattern := range rewritePatterns {
		result, err := runner.Run(ctx, executable, context, Command{
			Operation: "git.inspect_mirror_rewrite_configuration",
			Arguments: []string{"--git-dir", mirrorPath, "config", "--local", "--get-regexp", pattern},
		})
		if err != nil {
			return err
		}
		if result.ExitCode != nil && *result.ExitCode == 1 {
			continue
		}
		if err = RequireSuccess(result); err != nil {
			return err
		}
		if strings.TrimSpace(result.Stdout) != "" {
			return fmt.Errorf("%w: Managed Git mirror contains a local configuration rewrite or include.", ErrRemoteInvalid)
		}
	}
	return nil
}

// fetchMirrorRemote fetches only the named remote's branches and tags into the
// remote-tracking namespace the launcher resolves revisions from.
func fetchMirrorRemote(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, mirrorPath, remoteName string) error {
	if err := AssertRemoteName(remoteName); err != nil {
		return err
	}
	_, err := RunRequiredGitCommand(ctx, runner, executable, context, Command{
		Operation: "git.fetch_managed_mirror",
		Arguments: []string{
			"--git-dir", mirrorPath,
			"fetch", "--no-write-fetch-head", "--prune", "--prune-tags",
			remoteName,
			"+refs/heads/*:refs/remotes/" + remoteName + "/*",
			"+refs/tags/*:refs/tags/*",
		},
	})
	return err
}

// assertPathAbsent refuses to build on top of something that is already there.
func assertPathAbsent(path string, code error, message string) error {
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%w: Managed Git path could not be inspected.", ErrOperationFailed)
	}
	return fmt.Errorf("%w: %s", code, message)
}

// assertDirectRegularBundleFile refuses anything but a canonical absolute path to
// a regular file that is not a link: a bundle is imported by path, and a link
// there would import something the caller never verified.
func assertDirectRegularBundleFile(bundlePath string) error {
	if err := AssertCanonicalAbsolutePath(bundlePath, "Managed Git bundle path", ErrRepositoryInvalid); err != nil {
		return err
	}
	metadata, err := os.Lstat(bundlePath)
	if err != nil {
		return fmt.Errorf("%w: Managed Git bundle is unavailable.", ErrRepositoryInvalid)
	}
	if metadata.Mode()&os.ModeSymlink != 0 || !metadata.Mode().IsRegular() {
		return fmt.Errorf("%w: Managed Git bundle must be a direct regular file.", ErrRepositoryInvalid)
	}
	return nil
}

// assertSameFilesystem keeps the publication rename inside one filesystem: a
// rename across devices is a copy, and a copy is not atomic.
func assertSameFilesystem(left, right string) error {
	leftDevice, err := deviceOf(left)
	if err != nil {
		return fmt.Errorf("%w: Managed Git publication directories could not be inspected.", ErrOperationFailed)
	}
	rightDevice, err := deviceOf(right)
	if err != nil {
		return fmt.Errorf("%w: Managed Git publication directories could not be inspected.", ErrOperationFailed)
	}
	if leftDevice != rightDevice {
		return fmt.Errorf("%w: Managed Git staging and mirror publication directories differ.", ErrOperationFailed)
	}
	return nil
}

func deviceOf(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	fingerprint, err := readFingerprint(path, info)
	if err != nil {
		return 0, err
	}
	return fingerprint.Device, nil
}

// nonEmptyLines lists the non-empty lines of a command's stdout.
func nonEmptyLines(stdout string) []string {
	lines := make([]string, 0, 1)
	for _, line := range strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
