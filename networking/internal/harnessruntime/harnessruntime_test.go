package harnessruntime

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func launchRequest(base string) LaunchRequest {
	return LaunchRequest{
		LaunchID:             "launch_main",
		SubjectID:            "subject_main",
		Directory:            filepath.Join(base, "version"),
		PnpmExecutable:       filepath.Join(base, "pnpm"),
		DiagnosticsPatchPath: filepath.Join(base, "verbose.patch.yml"),
		Port:                 AutoPort(),
		LogPath:              filepath.Join(base, "logs", "dsh-web.log"),
	}
}

// TestBuildCommandMatchesTheShell pins the exact command the Launcher used to
// spawn itself, including the argument order the DSH CLI parses.
func TestBuildCommandMatchesTheShell(t *testing.T) {
	base := t.TempDir()
	request := launchRequest(base)
	request.Port = PortSetting{Mode: "fixed", Port: 3088}
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	want := []string{
		"dsh", "web",
		"--patch", request.DiagnosticsPatchPath,
		"--no-open",
		"--port", "3088",
	}
	if strings.Join(command.Arguments, " ") != strings.Join(want, " ") {
		t.Fatalf("arguments = %v", command.Arguments)
	}
	if command.Executable != request.PnpmExecutable || command.Directory != request.Directory {
		t.Fatalf("command = %+v", command)
	}

	request.Port = AutoPort()
	automatic, err := BuildCommand(request)
	if err != nil {
		t.Fatalf("auto: %v", err)
	}
	if strings.Join(automatic.Arguments, " ") != strings.Join(want[:5], " ") {
		t.Fatalf("automatic arguments = %v", automatic.Arguments)
	}
}

// TestBuildCommandForwardsThePnpmShim covers the platforms whose pnpm is a
// shell shim: the prefix arguments and the PATH its subprocesses need travel
// with the command, and a shim that could not be resolved refuses the launch.
func TestBuildCommandForwardsThePnpmShim(t *testing.T) {
	base := t.TempDir()
	request := launchRequest(base)
	request.PnpmPrefixArguments = []string{"shim.js"}
	request.PnpmCommandSearchPath = filepath.Join(base, "bin")
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if command.Arguments[0] != "shim.js" || command.Path != request.PnpmCommandSearchPath {
		t.Fatalf("command = %+v", command)
	}

	request.PnpmResolutionError = "pnpm is unavailable"
	if _, err := BuildCommand(request); !errors.Is(err, ErrSpawnFailed) {
		t.Fatalf("unresolved shim = %v", err)
	}
}

func TestBuildCommandRefusesInvalidInput(t *testing.T) {
	base := t.TempDir()
	cases := map[string]func(*LaunchRequest){
		"a relative directory": func(request *LaunchRequest) { request.Directory = "version" },
		"an unclean directory": func(request *LaunchRequest) {
			request.Directory = base + string(filepath.Separator) + "version" + string(filepath.Separator) + ".." + string(filepath.Separator) + "version"
		},
		"a missing log path":    func(request *LaunchRequest) { request.LogPath = "" },
		"an unopaque launch id": func(request *LaunchRequest) { request.LaunchID = "launch main" },
		"a privileged port":     func(request *LaunchRequest) { request.Port = PortSetting{Mode: "fixed", Port: 80} },
		"an out of range port":  func(request *LaunchRequest) { request.Port = PortSetting{Mode: "fixed", Port: 65536} },
		"an unknown mode":       func(request *LaunchRequest) { request.Port = PortSetting{Mode: "sometimes"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			request := launchRequest(base)
			mutate(&request)
			if _, err := BuildCommand(request); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

func TestAssertPortSettingMatchesTheShellRange(t *testing.T) {
	for _, port := range []int{1024, 3088, 65535} {
		if _, err := FixedPort(port); err != nil {
			t.Fatalf("port %d: %v", port, err)
		}
	}
	for _, port := range []int{80, 1023, 65536, 0, -1} {
		if _, err := FixedPort(port); !errors.Is(err, ErrInputInvalid) {
			t.Fatalf("port %d = %v", port, err)
		}
	}
}

// TestParseAnnouncedWebURLAcceptsOnlyLoopback pins the rule that keeps a log
// line quoting some other address from redirecting the runtime view.
func TestParseAnnouncedWebURLAcceptsOnlyLoopback(t *testing.T) {
	accepted := map[string]string{
		"dsh web: http://127.0.0.1:3088":            "http://127.0.0.1:3088/",
		"dsh web: http://127.0.0.1:3088/":           "http://127.0.0.1:3088/",
		"dsh web: http://localhost:3088/?token=abc": "http://localhost:3088/?token=abc",
		"dsh web: https://127.0.0.1:4443/#frag":     "https://127.0.0.1:4443/#frag",
		"dsh web: http://[::1]:3088":                "http://[::1]:3088/",
		"dsh web: http://127.0.0.1:3088\r":          "http://127.0.0.1:3088/",
		"dsh web:   http://127.0.0.1:3088":          "http://127.0.0.1:3088/",
	}
	for line, expected := range accepted {
		value, ok := ParseAnnouncedWebURL(line)
		if !ok || value != expected {
			t.Errorf("%q = %q, %v", line, value, ok)
		}
	}
	refused := []string{
		"dsh web: http://192.168.1.9:3088",
		"dsh web: http://example.com:3088/",
		"dsh web: file:///tmp/dsh",
		"dsh web:",
		"web: http://127.0.0.1:3088",
		"prefix dsh web: http://127.0.0.1:3088",
		"dsh web: not-a-url",
	}
	for _, line := range refused {
		if value, ok := ParseAnnouncedWebURL(line); ok {
			t.Errorf("%q was accepted as %q", line, value)
		}
	}
}

// TestLineObserverWaitsForCompleteLines covers the split-chunk case: adopting a
// truncated URL would drop the session credential DSH puts in its query.
func TestLineObserverWaitsForCompleteLines(t *testing.T) {
	observer := &LineObserver{}
	if _, ok := observer.Observe("dsh web: http://127.0.0.1:30"); ok {
		t.Fatal("an incomplete line was adopted")
	}
	url, ok := observer.Observe("88/?token=secret\n")
	if !ok || url != "http://127.0.0.1:3088/?token=secret" {
		t.Fatalf("announcement = %q, %v", url, ok)
	}
	observer.Reset()
	if _, ok := observer.Observe("88/?token=secret\n"); ok {
		t.Fatal("buffering survived a reset")
	}
}

func TestConsoleKeepsABoundedCursorFeed(t *testing.T) {
	console := &Console{}
	console.Append(StreamStdout, "first\n", time.UnixMilli(1_000))
	entries, cursor := console.After(0)
	if len(entries) != 1 || cursor != 1 || entries[0].OccurredAtUnix != 1_000 {
		t.Fatalf("first read = %+v, %d", entries, cursor)
	}
	if entries, cursor := console.After(cursor); len(entries) != 0 || cursor != 1 {
		t.Fatalf("second read = %+v, %d", entries, cursor)
	}
	for index := 0; index < MaxConsoleEntries+50; index++ {
		console.Append(StreamStdout, "line", time.UnixMilli(2_000))
	}
	entries, cursor = console.After(0)
	if len(entries) != MaxConsoleEntries {
		t.Fatalf("retained %d entries", len(entries))
	}
	if entries[0].Sequence != 52 || cursor != int64(MaxConsoleEntries+51) {
		t.Fatalf("tail starts at %d, cursor %d", entries[0].Sequence, cursor)
	}
	// A reader whose cursor the cap has passed still receives the retained tail.
	if entries, _ := console.After(2); len(entries) != MaxConsoleEntries {
		t.Fatalf("stale cursor read %d entries", len(entries))
	}
}

func TestClassifyChildConsoleStreamKeepsPnpmEchoesRecognizable(t *testing.T) {
	if value := ClassifyChildConsoleStream(StreamStderr, "$ dsh web --no-open\n"); value != StreamCommand {
		t.Fatalf("pnpm echo = %q", value)
	}
	if value := ClassifyChildConsoleStream(StreamStderr, "Error: address already in use\n"); value != StreamStderr {
		t.Fatalf("diagnostic = %q", value)
	}
	if value := ClassifyChildConsoleStream(StreamStdout, "$ not-an-echo\n"); value != StreamStdout {
		t.Fatalf("stdout = %q", value)
	}
}

// TestPreferencesRoundTripsTheShellsDocument pins the persisted bytes: the same
// two-space document the shell wrote, so an existing file is adopted in place.
func TestPreferencesRoundTripsTheShellsDocument(t *testing.T) {
	base := t.TempDir()
	store, err := OpenPreferences(filepath.Join(base, PreferencesFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	setting, err := store.Load()
	if err != nil || setting.Mode != "auto" {
		t.Fatalf("missing document = %+v, %v", setting, err)
	}
	if err := store.Save(PortSetting{Mode: "fixed", Port: 3088}); err != nil {
		t.Fatalf("save: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(base, PreferencesFileName))
	if err != nil {
		t.Fatal(err)
	}
	golden := "{\n  \"format\": \"dsh-launcher.launch-preferences\",\n  \"port\": {\n    \"mode\": \"fixed\",\n    \"port\": 3088\n  }\n}\n"
	if string(raw) != golden {
		t.Fatalf("persisted bytes = %q", raw)
	}
	if setting, err := store.Load(); err != nil || setting.Port != 3088 {
		t.Fatalf("reload = %+v, %v", setting, err)
	}
}

func TestOpenPreferencesOwnsExactlyOneFile(t *testing.T) {
	base := t.TempDir()
	for name, path := range map[string]string{
		"another file name": filepath.Join(base, "preferences.json"),
		"a relative path":   PreferencesFileName,
		"an empty path":     "",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := OpenPreferences(path); !errors.Is(err, ErrPreferencesFailed) {
				t.Fatalf("OpenPreferences(%q) = %v", path, err)
			}
		})
	}
}

// TestParseLaunchPreferencesNeverFailsOnContent covers the recovery rule: a
// record this build cannot use means "automatic port", never a launch failure.
func TestParseLaunchPreferencesNeverFailsOnContent(t *testing.T) {
	for name, document := range map[string]string{
		"not json":          "{",
		"another format":    `{"format":"other","port":{"mode":"fixed","port":3088}}`,
		"an unknown mode":   `{"format":"dsh-launcher.launch-preferences","port":{"mode":"sometimes"}}`,
		"a privileged port": `{"format":"dsh-launcher.launch-preferences","port":{"mode":"fixed","port":80}}`,
		"a fractional port": `{"format":"dsh-launcher.launch-preferences","port":{"mode":"fixed","port":3088.5}}`,
		"a missing port":    `{"format":"dsh-launcher.launch-preferences"}`,
		"an explicit auto":  `{"format":"dsh-launcher.launch-preferences","port":{"mode":"auto"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if setting := ParseLaunchPreferences([]byte(document)); setting.Mode != "auto" {
				t.Fatalf("%s = %+v", name, setting)
			}
		})
	}
	usable := `{"format":"dsh-launcher.launch-preferences","port":{"mode":"fixed","port":3088}}`
	if setting := ParseLaunchPreferences([]byte(usable)); setting.Port != 3088 {
		t.Fatalf("usable document = %+v", setting)
	}
}

func TestIsResidualDshWebCommandMatchesTheShellRule(t *testing.T) {
	for _, command := range []string{
		"node /opt/dsh/apps/cli/lib/bin.js web --no-open",
		"pnpm dsh web --patch /x --no-open",
		"/usr/local/bin/dsh web",
	} {
		if !IsResidualDshWebCommand(command) {
			t.Errorf("%q was not adopted", command)
		}
	}
	for _, command := range []string{"", "   ", "node /srv/api/server.js", "postgres -D /data"} {
		if IsResidualDshWebCommand(command) {
			t.Errorf("%q was adopted", command)
		}
	}
}

// managedRequest is one managed installation's launch: its own Node, its own
// worktree, and no pnpm facts at all.
func managedRequest(base, directory string) LaunchRequest {
	return LaunchRequest{
		LaunchID:       "launch_managed",
		SubjectID:      "installation_main",
		Directory:      directory,
		Profile:        ProfileNode,
		NodeExecutable: filepath.Join(base, "node"),
		Port:           AutoPort(),
	}
}

// writeBuiltEntry creates the direct built entry a managed checkout must have.
func writeBuiltEntry(t *testing.T, directory string) {
	t.Helper()
	entry := filepath.Join(directory, filepath.FromSlash(ManagedEntryPath))
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("// built dsh entry\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestBuildCommandForAManagedInstallation pins the command the shell used to
// spawn itself for one managed installation: the installation's own Node, the
// entry named relative to the worktree it is started in, and a port only when
// one was fixed.
func TestBuildCommandForAManagedInstallation(t *testing.T) {
	base := t.TempDir()
	directory := filepath.Join(base, "worktree")
	writeBuiltEntry(t, directory)
	request := managedRequest(base, directory)

	command, err := BuildCommand(request)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	want := []string{ManagedEntryPath, "web", "--no-open"}
	if strings.Join(command.Arguments, " ") != strings.Join(want, " ") {
		t.Fatalf("arguments = %v", command.Arguments)
	}
	if command.Executable != request.NodeExecutable || command.Directory != directory {
		t.Fatalf("command = %+v", command)
	}
	if command.Path != "" {
		t.Fatalf("path override = %q", command.Path)
	}

	fixed, err := FixedPort(3088)
	if err != nil {
		t.Fatal(err)
	}
	request.Port = fixed
	withPort, err := BuildCommand(request)
	if err != nil {
		t.Fatalf("fixed: %v", err)
	}
	expected := append(append([]string{}, want...), "--port", "3088")
	if strings.Join(withPort.Arguments, " ") != strings.Join(expected, " ") {
		t.Fatalf("fixed arguments = %v", withPort.Arguments)
	}
}

// TestAssertBuiltEntryRefusesIndirectEntries covers the shell's own rule: a
// missing, indirect or replaced entry is refused before anything is spawned.
func TestAssertBuiltEntryRefusesIndirectEntries(t *testing.T) {
	base := t.TempDir()
	if err := AssertBuiltEntry(base); !errors.Is(err, ErrWorktreeInvalid) {
		t.Fatalf("missing entry = %v", err)
	}
	directory := filepath.Join(base, "worktree")
	writeBuiltEntry(t, directory)
	if err := AssertBuiltEntry(directory); err != nil {
		t.Fatalf("direct entry = %v", err)
	}

	entry := filepath.Join(directory, filepath.FromSlash(ManagedEntryPath))
	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(entry, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := AssertBuiltEntry(directory); !errors.Is(err, ErrWorktreeInvalid) {
		t.Fatalf("directory entry = %v", err)
	}

	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "elsewhere.js"), entry); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := AssertBuiltEntry(directory); !errors.Is(err, ErrWorktreeInvalid) {
		t.Fatalf("symlinked entry = %v", err)
	}
}

// TestAssertLaunchRequestChecksTheManagedProfile confirms the two profiles
// require the facts they actually use and nothing else.
func TestAssertLaunchRequestChecksTheManagedProfile(t *testing.T) {
	base := t.TempDir()
	directory := filepath.Join(base, "worktree")
	writeBuiltEntry(t, directory)

	request := managedRequest(base, directory)
	request.NodeExecutable = "node"
	if err := AssertLaunchRequest(request); !errors.Is(err, ErrInputInvalid) {
		t.Fatalf("relative node = %v", err)
	}
	request = managedRequest(base, directory)
	request.LogPath = filepath.Join(base, "logs", "managed.log")
	if err := AssertLaunchRequest(request); err != nil {
		t.Fatalf("absolute log = %v", err)
	}
	request = managedRequest(base, directory)
	request.Profile = "shell"
	if err := AssertLaunchRequest(request); !errors.Is(err, ErrInputInvalid) {
		t.Fatalf("unknown profile = %v", err)
	}
	request = managedRequest(base, directory)
	request.Directory = "worktree"
	if err := AssertLaunchRequest(request); !errors.Is(err, ErrInputInvalid) {
		t.Fatalf("relative directory = %v", err)
	}
}
