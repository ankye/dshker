package gitcheckout

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// isWindows reports the platform the deterministic arguments depend on.
func isWindows() bool {
	return runtime.GOOS == "windows"
}

// streamTarget names which of the two streams a chunk came from.
type streamTarget int

const (
	stdoutText streamTarget = iota
	stderrText
)

// terminated explains why a process was killed before it finished.
type terminated int

const (
	terminatedNone terminated = iota
	terminatedTimeout
	terminatedCancelled
	terminatedOutputLimit
)

// termination records the first reason a process was killed; later attempts to
// record another one are ignored, so the report names the cause and not the
// straggler.
type termination struct {
	mu      sync.Mutex
	reason_ terminated
}

func (ended *termination) set(reason terminated) {
	ended.mu.Lock()
	defer ended.mu.Unlock()
	if ended.reason_ == terminatedNone {
		ended.reason_ = reason
	}
}

func (ended *termination) reason() terminated {
	ended.mu.Lock()
	defer ended.mu.Unlock()
	return ended.reason_
}

// Fingerprint is the file identity of one executable, in the same shape the
// installation catalog persists.
type Fingerprint struct {
	Device                 int64 `json:"device"`
	Inode                  int64 `json:"inode"`
	Size                   int64 `json:"size"`
	ModifiedAtMilliseconds int64 `json:"modifiedAtMilliseconds"`
}

// Executable is one registered git: the path the user selected, the realpath it
// resolved to, the file identity pinned at registration and the version it
// answered.
type Executable struct {
	RequestedPath string      `json:"requestedPath"`
	CanonicalPath string      `json:"canonicalPath"`
	Fingerprint   Fingerprint `json:"fingerprint"`
	Version       Version     `json:"version"`
}

// Command is one named invocation. The operation name is what a failure reports,
// and the arguments are the operation's own — the runner adds the deterministic
// prefix.
type Command struct {
	Operation string
	Arguments []string
}

// OperationPattern is the only operation-name shape a command may have.
var OperationPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{1,127}$`)

// Result is the bounded, credential-redacted observation of one invocation.
type Result struct {
	Operation           string
	ExecutablePath      string
	WorkingDirectory    string
	EnvironmentNames    []string
	Arguments           []string
	ExitCode            *int
	Signal              string
	Stdout              string
	Stderr              string
	ElapsedMilliseconds int64
}

// Runner runs git without a shell. It holds no state: everything an invocation
// needs is passed in, so a caller cannot inherit anything from a previous one.
type Runner struct {
	MaximumRunning int
}

// NewRunner returns a runner for direct git invocations.
func NewRunner() *Runner {
	return &Runner{}
}

// PinExecutable resolves an explicitly selected executable and pins its file
// identity. It runs nothing.
func PinExecutable(absolutePath string) (Executable, error) {
	if err := AssertCanonicalAbsolutePath(absolutePath, "Git executable", ErrExecutableInvalid); err != nil {
		return Executable{}, err
	}
	canonicalPath, err := filepath.EvalSymlinks(absolutePath)
	if err != nil {
		return Executable{}, fmt.Errorf("%w: Git executable cannot be resolved.", ErrExecutableUnavailable)
	}
	fingerprint, err := fingerprintOf(canonicalPath)
	if err != nil {
		return Executable{}, err
	}
	return Executable{
		RequestedPath: absolutePath,
		CanonicalPath: canonicalPath,
		Fingerprint:   fingerprint,
	}, nil
}

// AssertExecutable re-checks a registration against the file on disk: the same
// realpath, resolved again, and the same file identity. It is what makes a
// registration a claim about a file rather than a claim about a path.
func AssertExecutable(executable Executable) error {
	if err := AssertCanonicalAbsolutePath(executable.RequestedPath, "Registered Git executable", ErrExecutableInvalid); err != nil {
		return err
	}
	if err := AssertCanonicalAbsolutePath(executable.CanonicalPath, "Registered Git executable", ErrExecutableInvalid); err != nil {
		return err
	}
	canonicalPath, err := filepath.EvalSymlinks(executable.RequestedPath)
	if err != nil {
		return fmt.Errorf("%w: Registered Git executable is unavailable.", ErrExecutableUnavailable)
	}
	fingerprint, err := fingerprintOf(canonicalPath)
	if err != nil {
		return err
	}
	if canonicalPath != executable.CanonicalPath || fingerprint != executable.Fingerprint {
		return fmt.Errorf("%w: Registered Git executable changed after registration.", ErrExecutableChanged)
	}
	return nil
}

func fingerprintOf(path string) (Fingerprint, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Fingerprint{}, fmt.Errorf("%w: Git executable cannot be resolved.", ErrExecutableUnavailable)
	}
	if !info.Mode().IsRegular() {
		return Fingerprint{}, fmt.Errorf("%w: Git executable must be a regular file.", ErrExecutableInvalid)
	}
	if !executableBitSatisfied(info) {
		return Fingerprint{}, fmt.Errorf("%w: Git executable is not executable.", ErrExecutableInvalid)
	}
	return readFingerprint(path, info)
}

// RegisterExecutable pins an executable, probes its version and applies the
// policy, in that order: nothing is registered that has not answered, and nothing
// is trusted that changed while it answered.
func RegisterExecutable(ctx context.Context, absolutePath string, context ExecutionContext, policy VersionPolicy) (Executable, error) {
	if err := AssertVersionPolicy(policy); err != nil {
		return Executable{}, err
	}
	pinned, err := PinExecutable(absolutePath)
	if err != nil {
		return Executable{}, err
	}
	version, err := NewRunner().ProbeVersion(ctx, absolutePath, context)
	if err != nil {
		return Executable{}, err
	}
	if err := AssertExecutable(pinned); err != nil {
		return Executable{}, err
	}
	if err := AssertVersionSupported(version, policy); err != nil {
		return Executable{}, err
	}
	pinned.Version = version
	return pinned, nil
}

// ProbeVersion pins an executable that has no version yet, asks it for one and
// parses the answer.
func (runner *Runner) ProbeVersion(ctx context.Context, absolutePath string, context ExecutionContext) (Version, error) {
	pinned, err := PinExecutable(absolutePath)
	if err != nil {
		return Version{}, err
	}
	result, err := runner.runPinned(ctx, pinned.CanonicalPath, context, Command{
		Operation: "git.version_probe",
		Arguments: []string{"--version"},
	})
	if err != nil {
		return Version{}, err
	}
	if err := RequireSuccess(result); err != nil {
		return Version{}, err
	}
	return ParseVersion(result.Stdout)
}

// Run executes one command only after the pinned executable identity still
// matches.
func (runner *Runner) Run(ctx context.Context, executable Executable, context ExecutionContext, command Command) (Result, error) {
	if err := AssertExecutable(executable); err != nil {
		return Result{}, err
	}
	return runner.runPinned(ctx, executable.CanonicalPath, context, command)
}

// AssertCommand refuses an operation identity or an argument that could not be
// passed to a process.
func AssertCommand(command Command) error {
	if !OperationPattern.MatchString(command.Operation) {
		return fmt.Errorf("%w: Git command operation identity is invalid.", ErrCommandInvalid)
	}
	for _, argument := range command.Arguments {
		if strings.ContainsRune(argument, 0) {
			return fmt.Errorf("%w: Git command arguments are invalid.", ErrCommandInvalid)
		}
	}
	return nil
}

// DeterministicArguments prepends the prefix every invocation carries: no pager,
// no credential helper, no repository hooks, and on Windows git's long-path file
// APIs, because a staging mirror path plus a pack file name already exceeds the
// 260-character limit otherwise.
func DeterministicArguments(arguments []string, windows bool) []string {
	nullDevice := "/dev/null"
	if windows {
		nullDevice = "NUL"
	}
	prefix := []string{"--no-pager", "-c", "credential.helper=", "-c", "core.hooksPath=" + nullDevice}
	if windows {
		prefix = append(prefix, "-c", "core.longpaths=true")
	}
	return append(prefix, arguments...)
}

func (runner *Runner) runPinned(ctx context.Context, executable string, context ExecutionContext, command Command) (Result, error) {
	if err := AssertExecutionContext(context); err != nil {
		return Result{}, err
	}
	if err := AssertCommand(command); err != nil {
		return Result{}, err
	}
	if ctx.Err() != nil {
		return Result{}, fmt.Errorf("%w: Git command was cancelled before it started.", ErrCommandCancelled)
	}
	started := time.Now()
	process := exec.Command(executable, DeterministicArguments(command.Arguments, isWindows())...)
	process.Dir = context.WorkingDirectory
	process.Env = environmentList(context.Environment)
	stdout, err := process.StdoutPipe()
	if err != nil {
		return Result{}, fmt.Errorf("%w: Git executable could not start.", ErrExecutableUnavailable)
	}
	stderr, err := process.StderrPipe()
	if err != nil {
		return Result{}, fmt.Errorf("%w: Git executable could not start.", ErrExecutableUnavailable)
	}
	if err = process.Start(); err != nil {
		return Result{}, fmt.Errorf("%w: Git executable could not start.", ErrExecutableUnavailable)
	}

	captured := newCapture(context.MaximumOutputBytes)
	termination := &termination{}
	var readers sync.WaitGroup
	readers.Add(2)
	go captured.copyFrom(&readers, stdoutText, stdout, process, termination)
	go captured.copyFrom(&readers, stderrText, stderr, process, termination)

	timer := time.AfterFunc(time.Duration(context.TimeoutMilliseconds)*time.Millisecond, func() {
		termination.set(terminatedTimeout)
		_ = process.Process.Kill()
	})
	stopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			termination.set(terminatedCancelled)
			_ = process.Process.Kill()
		case <-stopped:
		}
	}()

	waitErr := process.Wait()
	close(stopped)
	timer.Stop()
	readers.Wait()

	switch termination.reason() {
	case terminatedTimeout:
		return Result{}, fmt.Errorf("%w: Git command exceeded its declared timeout.", ErrCommandTimeout)
	case terminatedCancelled:
		return Result{}, fmt.Errorf("%w: Git command was cancelled.", ErrCommandCancelled)
	case terminatedOutputLimit:
		return Result{}, fmt.Errorf("%w: Git command exceeded its output limit.", ErrCommandOutputLimit)
	}
	var exitError *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exitError) {
		return Result{}, fmt.Errorf("%w: Git executable could not start.", ErrExecutableUnavailable)
	}
	exitCode, signal := exitStatus(process.ProcessState)
	return Result{
		Operation:           command.Operation,
		ExecutablePath:      executable,
		WorkingDirectory:    context.WorkingDirectory,
		EnvironmentNames:    environmentNames(context.Environment),
		Arguments:           redactAll(command.Arguments),
		ExitCode:            exitCode,
		Signal:              signal,
		Stdout:              RedactOutput(captured.text(stdoutText)),
		Stderr:              RedactOutput(captured.text(stderrText)),
		ElapsedMilliseconds: time.Since(started).Milliseconds(),
	}, nil
}

// RequireSuccess turns a completed non-zero invocation into an actionable
// failure that carries the bounded observation, not the whole output.
func RequireSuccess(result Result) error {
	if result.ExitCode != nil && *result.ExitCode == 0 {
		return nil
	}
	return fmt.Errorf(
		"%w: Git command failed (%s in %s, exit %s).",
		ErrCommandFailed, result.Operation, result.WorkingDirectory, exitText(result),
	)
}

func exitText(result Result) string {
	if result.ExitCode == nil {
		if result.Signal == "" {
			return "unknown"
		}
		return result.Signal
	}
	return fmt.Sprint(*result.ExitCode)
}

func environmentList(environment map[string]string) []string {
	names := environmentNames(environment)
	list := make([]string, 0, len(names))
	for _, name := range names {
		list = append(list, name+"="+environment[name])
	}
	return list
}

func environmentNames(environment map[string]string) []string {
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func redactAll(values []string) []string {
	redacted := make([]string, 0, len(values))
	for _, value := range values {
		redacted = append(redacted, RedactOutput(value))
	}
	return redacted
}

// The redaction rules: a URL's credentials, an authorization header, and the two
// labels a credential is most often printed under. They are applied to every
// observation that leaves this package, so a diagnostic can never carry a secret.
var (
	urlCredentialPattern = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)([^\s/@:]+(?::[^\s/@]*)?@)`)
	labelPatterns        = []*regexp.Regexp{
		regexp.MustCompile(`(?i)(authorization\s*[=:]\s*)[^\r\n]+`),
		regexp.MustCompile(`(?i)((?:token|password)\s*[=:]\s*)[^\s\r\n]+`),
	}
)

// RedactOutput removes URL credentials and common authentication labels from one
// piece of output.
func RedactOutput(value string) string {
	redacted := urlCredentialPattern.ReplaceAllString(value, "$1[REDACTED]@")
	for _, pattern := range labelPatterns {
		redacted = pattern.ReplaceAllString(redacted, "$1[REDACTED]")
	}
	return redacted
}

type capture struct {
	limit    int
	total    int64
	mu       sync.Mutex
	stdout   bytes.Buffer
	stderr   bytes.Buffer
	exceeded atomic.Bool
}

func newCapture(limit int) *capture {
	return &capture{limit: limit}
}

// copyFrom drains one stream into the bounded capture. The two streams share one
// byte budget, so a command cannot double its allowance by writing to both.
func (captured *capture) copyFrom(readers *sync.WaitGroup, target streamTarget, stream io.ReadCloser, process *exec.Cmd, ended *termination) {
	defer readers.Done()
	defer stream.Close()
	buffer := make([]byte, 32*1024)
	for {
		read, err := stream.Read(buffer)
		if read > 0 {
			captured.write(target, buffer[:read], process, ended)
		}
		if err != nil {
			return
		}
	}
}

func (captured *capture) write(target streamTarget, chunk []byte, process *exec.Cmd, ended *termination) {
	total := atomic.AddInt64(&captured.total, int64(len(chunk)))
	if total > int64(captured.limit) {
		if captured.exceeded.CompareAndSwap(false, true) {
			ended.set(terminatedOutputLimit)
			_ = process.Process.Kill()
		}
		return
	}
	captured.mu.Lock()
	defer captured.mu.Unlock()
	if target == stdoutText {
		captured.stdout.Write(chunk)
		return
	}
	captured.stderr.Write(chunk)
}

func (captured *capture) text(target streamTarget) string {
	captured.mu.Lock()
	defer captured.mu.Unlock()
	if target == stdoutText {
		return captured.stdout.String()
	}
	return captured.stderr.String()
}
