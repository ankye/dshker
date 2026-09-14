package gitcheckout

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// installationIDPattern is the only shape a managed installation id may have: it
// becomes a directory name below the namespace, so it cannot be a path.
var installationIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{2,127}$`)

// InstallationPaths is the fixed, launcher-owned layout of one managed
// installation.
type InstallationPaths struct {
	InstallationID   string `json:"installationId"`
	NamespacePath    string `json:"namespacePath"`
	InstallationPath string `json:"installationPath"`
	MirrorPath       string `json:"mirrorPath"`
	WorktreesPath    string `json:"worktreesPath"`
	StagingPath      string `json:"stagingPath"`
	LockPath         string `json:"lockPath"`
}

// NewInstallationPaths builds the layout below an already-validated Harness
// namespace. Every path it derives is proved to stay inside that namespace, so a
// later caller cannot be handed a path that is already an escape.
func NewInstallationPaths(namespacePath, installationID string) (InstallationPaths, error) {
	if err := AssertCanonicalAbsolutePath(namespacePath, "Managed Harness namespace", ErrManagedPathInvalid); err != nil {
		return InstallationPaths{}, err
	}
	if !installationIDPattern.MatchString(installationID) {
		return InstallationPaths{}, fmt.Errorf("%w: Managed installation id is invalid.", ErrManagedPathInvalid)
	}
	installationPath := filepath.Join(namespacePath, "dsh-launcher", "managed-installations", installationID)
	paths := InstallationPaths{
		InstallationID:   installationID,
		NamespacePath:    namespacePath,
		InstallationPath: installationPath,
		MirrorPath:       filepath.Join(installationPath, "mirror.git"),
		WorktreesPath:    filepath.Join(installationPath, "worktrees"),
		StagingPath:      filepath.Join(installationPath, "staging"),
		LockPath:         filepath.Join(installationPath, "operation.lock"),
	}
	for _, candidate := range []string{
		paths.InstallationPath,
		paths.MirrorPath,
		paths.WorktreesPath,
		paths.StagingPath,
		paths.LockPath,
	} {
		if err := AssertContainedManagedPath(paths, candidate); err != nil {
			return InstallationPaths{}, err
		}
	}
	return paths, nil
}

// SameRegisteredPath compares a git-reported path with its registered spelling.
// Git for Windows reports rev-parse paths with forward slashes and Windows path
// matching is case-insensitive; both spellings name the directory the launcher
// registered, so neither difference is a mismatch.
func SameRegisteredPath(observed, registered string) bool {
	normalizedObserved := filepath.Clean(observed)
	normalizedRegistered := filepath.Clean(registered)
	if isWindows() {
		return strings.EqualFold(normalizedObserved, normalizedRegistered)
	}
	return normalizedObserved == normalizedRegistered
}

// EnsureInstallationDirectories creates only the fixed launcher-owned parent
// directories, refusing a symlink or an unexpected file at any level. The mirror
// itself is not created here: creating it is what the mirror rules do.
func EnsureInstallationDirectories(paths InstallationPaths) error {
	if err := AssertCanonicalExistingDirectory(paths.NamespacePath, "Managed Harness namespace"); err != nil {
		return err
	}
	for _, target := range []string{
		filepath.Join(paths.NamespacePath, "dsh-launcher"),
		filepath.Join(paths.NamespacePath, "dsh-launcher", "managed-installations"),
		paths.InstallationPath,
		paths.WorktreesPath,
		paths.StagingPath,
	} {
		if err := ensureDirectoryBelow(paths.NamespacePath, target); err != nil {
			return err
		}
	}
	return nil
}

// AssertManagedTarget proves that an existing target is a direct, non-symlink
// child of the managed namespace: it is contained, it is not a link, its realpath
// is its own spelling, and that realpath is still inside the namespace.
func AssertManagedTarget(paths InstallationPaths, target, subject string) error {
	if err := AssertContainedManagedPath(paths, target); err != nil {
		return err
	}
	metadata, err := os.Lstat(target)
	if err != nil {
		return fmt.Errorf("%w: %s is unavailable.", ErrManagedPathInvalid, subject)
	}
	if metadata.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s must not be a symbolic link.", ErrManagedPathEscape, subject)
	}
	canonicalTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return fmt.Errorf("%w: %s cannot be canonicalized.", ErrManagedPathInvalid, subject)
	}
	if canonicalTarget != target || !isStrictlyInside(paths.NamespacePath, canonicalTarget) {
		return fmt.Errorf("%w: %s escapes the managed Harness namespace.", ErrManagedPathEscape, subject)
	}
	return nil
}

// AssertContainedManagedPath refuses any path that is not a canonical absolute
// path strictly below the authoritative namespace.
func AssertContainedManagedPath(paths InstallationPaths, target string) error {
	if err := AssertCanonicalAbsolutePath(target, "Managed Git path", ErrManagedPathInvalid); err != nil {
		return err
	}
	if !isStrictlyInside(paths.NamespacePath, target) {
		return fmt.Errorf("%w: Managed Git path escapes the Harness namespace.", ErrManagedPathEscape)
	}
	return nil
}

// ManagedWorktreePath returns the detached-worktree path of one full commit SHA.
// An abbreviated object id would name a directory that is not this commit, so it
// is refused rather than expanded.
func ManagedWorktreePath(paths InstallationPaths, commit string) (string, error) {
	sha, err := ParseCommitSHA(commit)
	if err != nil {
		return "", err
	}
	target := filepath.Join(paths.WorktreesPath, sha)
	if err := AssertContainedManagedPath(paths, target); err != nil {
		return "", err
	}
	return target, nil
}

// OperationLock is the launcher's own non-stealable lock for one managed
// installation. It is a directory, so creating it is atomic on every platform
// this launcher runs on, and it records its owner so a release cannot remove a
// lock that was taken over by someone else.
type OperationLock struct {
	paths     InstallationPaths
	ownerID   string
	ownerPath string
	released  bool
}

// AcquireOperationLock takes the lock for one installation.
func AcquireOperationLock(paths InstallationPaths) (*OperationLock, error) {
	if err := EnsureInstallationDirectories(paths); err != nil {
		return nil, err
	}
	if err := os.Mkdir(paths.LockPath, 0o700); err != nil {
		if os.IsExist(err) {
			return nil, fmt.Errorf("%w: A managed Git operation is already in progress.", ErrOperationLocked)
		}
		return nil, fmt.Errorf("%w: Managed Git operation lock could not be created.", ErrOperationFailed)
	}
	ownerID, err := newOwnerID()
	if err != nil {
		_ = os.Remove(paths.LockPath)
		return nil, fmt.Errorf("%w: Managed Git operation lock could not record its owner.", ErrOperationFailed)
	}
	ownerPath := filepath.Join(paths.LockPath, "owner.json")
	file, err := os.OpenFile(ownerPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, err = file.WriteString(ownerRecord(ownerID))
	}
	if closeErr := closeIfOpen(file); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(paths.LockPath)
		return nil, fmt.Errorf("%w: Managed Git operation lock could not record its owner.", ErrOperationFailed)
	}
	return &OperationLock{paths: paths, ownerID: ownerID, ownerPath: ownerPath}, nil
}

// Release removes exactly the lock directory this instance created, and only
// while its owner record still names this instance.
func (lock *OperationLock) Release() error {
	if lock.released {
		return fmt.Errorf("%w: Managed Git operation lock was already released.", ErrOperationLockLost)
	}
	text, err := os.ReadFile(lock.ownerPath)
	if err != nil {
		return fmt.Errorf("%w: Managed Git operation lock owner record is unavailable.", ErrOperationLockLost)
	}
	if string(text) != ownerRecord(lock.ownerID) {
		return fmt.Errorf("%w: Managed Git operation lock owner changed.", ErrOperationLockLost)
	}
	if err = os.Remove(lock.ownerPath); err == nil {
		err = os.Remove(lock.paths.LockPath)
	}
	if err != nil {
		return fmt.Errorf("%w: Managed Git operation lock could not be released.", ErrOperationLockLost)
	}
	lock.released = true
	return nil
}

// ownerRecord is the exact owner document: the same bytes the shell wrote, so a
// lock taken by either implementation is recognized by the other.
// ownerRecord is the exact owner document: the same bytes the shell wrote, so a
// lock taken by either implementation is recognized by the other.
func ownerRecord(ownerID string) string {
	return fmt.Sprintf("{\"ownerId\":%q}\n", ownerID)
}

func newOwnerID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func closeIfOpen(file *os.File) error {
	if file == nil {
		return nil
	}
	return file.Close()
}

// ensureDirectoryBelow walks one path below the namespace, creating what is
// missing and refusing anything that is not a direct directory: a symlink at any
// level would let the rest of the walk leave the namespace.
func ensureDirectoryBelow(namespacePath, target string) error {
	if !isStrictlyInside(namespacePath, target) {
		return fmt.Errorf("%w: Managed Git directory escapes the Harness namespace.", ErrManagedPathEscape)
	}
	relative, err := filepath.Rel(namespacePath, target)
	if err != nil {
		return fmt.Errorf("%w: Managed Git directory escapes the Harness namespace.", ErrManagedPathEscape)
	}
	cursor := namespacePath
	for _, segment := range strings.Split(relative, string(filepath.Separator)) {
		cursor = filepath.Join(cursor, segment)
		metadata, err := os.Lstat(cursor)
		switch {
		case err == nil:
			if !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: Managed Git directory is not a direct directory.", ErrManagedPathEscape)
			}
		case !os.IsNotExist(err):
			return fmt.Errorf("%w: Managed Git directory could not be inspected.", ErrOperationFailed)
		default:
			if err = os.Mkdir(cursor, 0o700); err != nil {
				return fmt.Errorf("%w: Managed Git directory could not be created.", ErrOperationFailed)
			}
			created, verifyErr := os.Lstat(cursor)
			if verifyErr != nil || !created.IsDir() || created.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: Managed Git directory changed during creation.", ErrManagedPathEscape)
			}
		}
	}
	return nil
}

func AssertCanonicalExistingDirectory(path, subject string) error {
	if err := AssertCanonicalAbsolutePath(path, subject, ErrManagedPathInvalid); err != nil {
		return err
	}
	metadata, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("%w: %s is unavailable.", ErrManagedPathInvalid, subject)
	}
	canonicalPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("%w: %s is unavailable.", ErrManagedPathInvalid, subject)
	}
	if !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 || canonicalPath != path {
		return fmt.Errorf("%w: %s must be an existing canonical directory.", ErrManagedPathInvalid, subject)
	}
	return nil
}

// isStrictlyInside reports whether child is below parent and is not parent. The
// test is a path element comparison rather than a prefix comparison, so a sibling
// whose name merely begins with two dots is not mistaken for an escape.
func isStrictlyInside(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return relative != "." && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative)
}
