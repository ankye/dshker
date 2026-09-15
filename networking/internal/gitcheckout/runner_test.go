package gitcheckout

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// canonicalDirectory returns a temporary directory that already is what
// EvalSymlinks would make of it, because every path this package accepts has to
// be canonical.
func canonicalDirectory(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	return directory
}

func executionContext(t *testing.T, workingDirectory string) ExecutionContext {
	t.Helper()
	environment, err := CreateExecutionEnvironment("darwin", "", "", "", "")
	if err != nil {
		t.Fatalf("environment: %v", err)
	}
	return ExecutionContext{
		WorkingDirectory:    workingDirectory,
		Environment:         environment,
		TimeoutMilliseconds: 30_000,
		MaximumOutputBytes:  1 << 20,
	}
}

func writeExecutable(t *testing.T, directory, name, content string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

// TestPinExecutablePinsAFileIdentity: a registration is a claim about a file, so
// the pin has to notice a replaced file and a vanished one, and it has to refuse
// something that is not an executable file in the first place.
func TestPinExecutablePinsAFileIdentity(t *testing.T) {
	directory := canonicalDirectory(t)
	path := writeExecutable(t, directory, "tool", "#!/bin/sh\nexit 0\n")

	pinned, err := PinExecutable(path)
	if err != nil {
		t.Fatalf("pin: %v", err)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	if pinned.RequestedPath != path || pinned.CanonicalPath != canonical {
		t.Fatalf("pinned paths = %q, %q", pinned.RequestedPath, pinned.CanonicalPath)
	}
	if pinned.Fingerprint.Size != int64(len("#!/bin/sh\nexit 0\n")) || pinned.Fingerprint.ModifiedAtMilliseconds <= 0 {
		t.Fatalf("fingerprint = %+v", pinned.Fingerprint)
	}
	if err = AssertExecutable(pinned); err != nil {
		t.Fatalf("an unchanged pin = %v", err)
	}

	if err = os.WriteFile(path, []byte("#!/bin/sh\nexit 1\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err = AssertExecutable(pinned); !errors.Is(err, ErrExecutableChanged) {
		t.Fatalf("a replaced file = %v", err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = AssertExecutable(pinned); !errors.Is(err, ErrExecutableUnavailable) {
		t.Fatalf("a vanished file = %v", err)
	}

	directoryOnly, err := PinExecutable(directory)
	if err == nil {
		t.Fatalf("a directory was pinned: %+v", directoryOnly)
	}
	if !errors.Is(err, ErrExecutableInvalid) {
		t.Fatalf("a directory = %v", err)
	}
	if !isWindows() {
		plain := filepath.Join(directory, "plain")
		if err = os.WriteFile(plain, []byte("#!/bin/sh\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err = PinExecutable(plain); !errors.Is(err, ErrExecutableInvalid) {
			t.Fatalf("a file without an executable bit = %v", err)
		}
	}
}

// TestRunnerRunsGitWithoutAShell uses the machine's own git: the version probe,
// a command that succeeds, a command that fails, and the bounded observation the
// caller gets back.
func TestRunnerRunsGitWithoutAShell(t *testing.T) {
	gitPath := machineGit(t)
	directory := canonicalDirectory(t)
	runner := NewRunner()

	version, err := runner.ProbeVersion(context.Background(), gitPath, executionContext(t, directory))
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if version.Text == "" || version.Major < 1 {
		t.Fatalf("probed version = %+v", version)
	}

	pinned, err := PinExecutable(gitPath)
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Run(context.Background(), pinned, executionContext(t, directory), Command{
		Operation: "git.version_probe",
		Arguments: []string{"--version"},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("exit = %v (signal %q)", result.ExitCode, result.Signal)
	}
	if !strings.Contains(result.Stdout, "git version") {
		t.Fatalf("stdout = %q", result.Stdout)
	}
	if result.ExecutablePath != pinned.CanonicalPath || result.WorkingDirectory != directory {
		t.Fatalf("result paths = %q, %q", result.ExecutablePath, result.WorkingDirectory)
	}
	if !contains(result.EnvironmentNames, "GIT_CONFIG_NOSYSTEM") || !sorted(result.EnvironmentNames) {
		t.Fatalf("environment names = %v", result.EnvironmentNames)
	}
	if len(result.Arguments) != 1 || result.Arguments[0] != "--version" {
		t.Fatalf("arguments = %v", result.Arguments)
	}
	if err = RequireSuccess(result); err != nil {
		t.Fatalf("a successful command = %v", err)
	}

	failed, err := runner.Run(context.Background(), pinned, executionContext(t, directory), Command{
		Operation: "git.resolve_reference_commit",
		Arguments: []string{"rev-parse", "--verify", "--end-of-options", "refs/heads/does-not-exist"},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if failed.ExitCode == nil || *failed.ExitCode == 0 {
		t.Fatalf("exit = %v", failed.ExitCode)
	}
	if err = RequireSuccess(failed); !errors.Is(err, ErrCommandFailed) {
		t.Fatalf("a failed command = %v", err)
	}
}

// TestRunnerBoundsAndRedacts is the part of the runner that has to hold whatever
// git does: a command that never finishes, a caller that gives up, a command that
// writes without end, and output carrying a credential.
func TestRunnerBoundsAndRedacts(t *testing.T) {
	if isWindows() {
		t.Skip("these scripts are POSIX shell")
	}
	directory := canonicalDirectory(t)
	runner := NewRunner()

	sleeper := writeExecutable(t, directory, "sleeper", `#!/bin/sh
sleep 30
`)
	pinnedSleeper, err := PinExecutable(sleeper)
	if err != nil {
		t.Fatal(err)
	}

	timeoutContext := executionContext(t, directory)
	timeoutContext.TimeoutMilliseconds = 150
	started := time.Now()
	if _, err = runner.Run(context.Background(), pinnedSleeper, timeoutContext, Command{Operation: "git.stalled", Arguments: []string{}}); !errors.Is(err, ErrCommandTimeout) {
		t.Fatalf("a command that outlived its timeout = %v", err)
	}
	if time.Since(started) > 10*time.Second {
		t.Fatal("the timeout did not kill the command")
	}

	cancelled, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	if _, err = runner.Run(cancelled, pinnedSleeper, executionContext(t, directory), Command{Operation: "git.cancelled", Arguments: []string{}}); !errors.Is(err, ErrCommandCancelled) {
		t.Fatalf("a cancelled command = %v", err)
	}
	cancel()

	noisy := writeExecutable(t, directory, "noisy", `#!/bin/sh
i=0
while [ $i -lt 400 ]; do
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  i=$((i + 1))
done
`)
	pinnedNoisy, err := PinExecutable(noisy)
	if err != nil {
		t.Fatal(err)
	}
	bounded := executionContext(t, directory)
	bounded.MaximumOutputBytes = 1_024
	if _, err = runner.Run(context.Background(), pinnedNoisy, bounded, Command{Operation: "git.noisy", Arguments: []string{}}); !errors.Is(err, ErrCommandOutputLimit) {
		t.Fatalf("a command that exceeded its output limit = %v", err)
	}

	leaky := writeExecutable(t, directory, "leaky", `#!/bin/sh
printf 'cloning https://runner:secret@example.com/team/repo
'
printf 'token=abc123
'
`)
	pinnedLeaky, err := PinExecutable(leaky)
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Run(context.Background(), pinnedLeaky, executionContext(t, directory), Command{Operation: "git.leaky", Arguments: []string{}})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.Contains(result.Stdout, "secret") || strings.Contains(result.Stdout, "abc123") {
		t.Fatalf("output was not redacted: %q", result.Stdout)
	}
	if !strings.Contains(result.Stdout, "https://[REDACTED]@example.com/team/repo") {
		t.Fatalf("the URL was not redacted in place: %q", result.Stdout)
	}
	if !strings.Contains(result.Stdout, "token=[REDACTED]") {
		t.Fatalf("the label was not redacted: %q", result.Stdout)
	}
}

func TestDeterministicArgumentsPrefixEveryCommand(t *testing.T) {
	posix := DeterministicArguments([]string{"fetch", "--prune"}, false)
	want := []string{"--no-pager", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "fetch", "--prune"}
	if strings.Join(posix, " ") != strings.Join(want, " ") {
		t.Fatalf("posix arguments = %v", posix)
	}
	windows := DeterministicArguments([]string{"fetch"}, true)
	if !contains(windows, "core.longpaths=true") || !contains(windows, "core.hooksPath=NUL") {
		t.Fatalf("windows arguments = %v", windows)
	}
}

func TestRedactOutput(t *testing.T) {
	cases := []struct{ value, want string }{
		{value: "https://user:secret@example.com/team/repo.git", want: "https://[REDACTED]@example.com/team/repo.git"},
		{value: "ssh://git@example.com/team/repo.git", want: "ssh://[REDACTED]@example.com/team/repo.git"},
		{value: "Authorization: Bearer abcdef", want: "Authorization: [REDACTED]"},
		{value: "password=hunter2 and token=abc", want: "password=[REDACTED] and token=[REDACTED]"},
		{value: "nothing to hide here", want: "nothing to hide here"},
	}
	for _, testCase := range cases {
		if got := RedactOutput(testCase.value); got != testCase.want {
			t.Errorf("RedactOutput(%q) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}

func TestAssertCommandRefusesWhatCannotBePassed(t *testing.T) {
	if err := AssertCommand(Command{Operation: "git.resolve_reference_commit", Arguments: []string{"--version"}}); err != nil {
		t.Fatalf("a valid command = %v", err)
	}
	for _, operation := range []string{"", "Git.version", "1git", "git version", strings.Repeat("g", 130)} {
		if err := AssertCommand(Command{Operation: operation}); !errors.Is(err, ErrCommandInvalid) {
			t.Errorf("AssertCommand(%q) = %v", operation, err)
		}
	}
	if err := AssertCommand(Command{Operation: "git.echo", Arguments: []string{"bad\x00argument"}}); !errors.Is(err, ErrCommandInvalid) {
		t.Fatalf("an argument with a null = %v", err)
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func sorted(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] > values[index] {
			return false
		}
	}
	return true
}
