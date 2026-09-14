package integration

// Task 6.1: the headless entry point. This drives a real `dshkerd serve` process
// and real client processes against it, because that is what the task claims: a
// machine with no desktop session is operated entirely from a command line, and
// the refusals reach a terminal as distinct codes rather than one generic
// failure.
import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// stateDirectoryForCLI returns a state directory the endpoint accepts. A Unix
// socket path is capped near 104 bytes, so it has to be short.
func stateDirectoryForCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return t.TempDir()
	}
	directory, err := os.MkdirTemp("/tmp", "dshkerd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return directory
}

// cliBinary builds the command under test once per test.
func cliBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "dshkerd")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build: %v", err)
	}
	return binary
}

// runCLICommand runs one client command and returns its streams.
func runCLICommand(t *testing.T, binary string, arguments ...string) (string, string, int) {
	t.Helper()
	command := exec.Command(binary, arguments...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			t.Fatalf("run %v: %v", arguments, err)
		}
	}
	return stdout.String(), stderr.String(), code
}

// startHeadlessCore starts `dshkerd serve` and waits for its readiness line.
func startHeadlessCore(t *testing.T, binary string, state string, dataRoot string) func() {
	t.Helper()
	command := exec.Command(binary, "serve", "--state", state, "--data", dataRoot)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	type readiness struct {
		Version int    `json:"version"`
		Serving bool   `json:"serving"`
		Socket  string `json:"socket"`
	}
	line := make(chan readiness, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var value readiness
			if json.Unmarshal(scanner.Bytes(), &value) == nil && value.Serving {
				line <- value
				return
			}
		}
	}()
	select {
	case value := <-line:
		if value.Version != 1 || value.Socket == "" {
			t.Fatalf("readiness = %+v", value)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the headless core never reported readiness")
	}
	stopped := false
	return func() {
		if stopped {
			return
		}
		stopped = true
		if runtime.GOOS == "windows" {
			_ = command.Process.Kill()
		} else {
			_ = command.Process.Signal(os.Interrupt)
		}
		done := make(chan struct{})
		go func() { _ = command.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = command.Process.Kill()
		}
	}
}

// TestHeadlessCLIOperatesTheCore drives the whole command surface.
func TestHeadlessCLIOperatesTheCore(t *testing.T) {
	binary := cliBinary(t)
	state := stateDirectoryForCLI(t)
	stop := startHeadlessCore(t, binary, state, t.TempDir())
	defer stop()

	// status answers from the core table and reports the runtime.
	stdout, stderr, code := runCLICommand(t, binary, "status", "--state", state, "--json")
	if code != 0 {
		t.Fatalf("status: %s", stderr)
	}
	var status struct {
		Version struct {
			Version int      `json:"version"`
			Methods []string `json:"methods"`
		} `json:"version"`
	}
	if json.Unmarshal([]byte(stdout), &status) != nil || len(status.Version.Methods) == 0 {
		t.Fatalf("status answered %s", stdout)
	}

	// The CLI reads the same roots document the shell reads, through the core.
	base := t.TempDir()
	registryPath := filepath.Join(base, "managed-root-registry.json")
	nativeHome := filepath.Join(base, "native-dsh-home")
	roots := make([]map[string]string, 0, 4)
	for _, kind := range []string{"harness", "plugins", "presets", "settings"} {
		roots = append(roots, map[string]string{
			"rootId":        "root_" + kind,
			"kind":          kind,
			"canonicalPath": filepath.Join(base, kind),
		})
	}
	payload, err := json.Marshal(map[string]any{
		"filePath":      registryPath,
		"nativeDshHome": nativeHome,
		"registry": map[string]any{
			"format":     "dsh-launcher.managed-root-registry",
			"version":    2,
			"roots":      roots,
			"workspaces": []any{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, stderr, code = runCLICommand(t, binary, "call", "core.roots_commit", string(payload), "--state", state); code != 0 {
		t.Fatalf("roots_commit: %s", stderr)
	}
	stdout, stderr, code = runCLICommand(t, binary, "roots",
		"--registry", registryPath, "--native-home", nativeHome, "--state", state)
	if code != 0 {
		t.Fatalf("roots: %s", stderr)
	}
	for _, kind := range []string{"harness", "plugins", "presets", "settings"} {
		if !strings.Contains(stdout, kind+"\troot_"+kind) {
			t.Fatalf("roots output lost %s: %s", kind, stdout)
		}
	}

	// A missing registry keeps its own code on the terminal, distinct from the
	// unknown-method and unknown-subject codes below.
	_, stderr, code = runCLICommand(t, binary, "roots",
		"--registry", filepath.Join(base, "absent", "managed-root-registry.json"),
		"--native-home", nativeHome, "--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "managed.missing_registry" {
		t.Fatalf("missing registry = %q (%d)", stderr, code)
	}

	// The reverse-proxy binding is a refusal before any child exists: a headless
	// host with nothing running has no address to hand a peer, which is a named
	// code rather than an invented one.
	_, stderr, code = runCLICommand(t, binary, "proxy", "--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.runtime_unavailable" {
		t.Fatalf("proxy before a launch = %q (%d)", stderr, code)
	}
	// Configuring a service without a coordinator address is refused before any
	// call is made.
	if _, stderr, code = runCLICommand(t, binary, "service", "configure", "--state", state); code != 1 ||
		!strings.Contains(stderr, "p2p.invalid_arguments") {
		t.Fatalf("service configure without an origin = %q (%d)", stderr, code)
	}

	// A stand-in for the workbench the DSH web child serves. It listens where the
	// fake launcher below says it does, so the endpoint a peer is handed is one
	// that really answers.
	workbench := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("token") == "" {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = writer.Write([]byte("<title>dsh-workbench</title>"))
	}))
	listener, listenErr := net.Listen("tcp", "127.0.0.1:3099")
	if listenErr != nil {
		t.Skipf("the workbench port is busy: %v", listenErr)
	}
	workbench.Listener = listener
	workbench.Start()
	defer workbench.Close()

	// dsh start runs a real child through the daemon and dsh stop ends it.
	worktree := t.TempDir()
	executable, prefix := writeFakeLauncher(t, worktree)
	startArguments := []string{"dsh", "start", "--state", state,
		"--directory", worktree, "--pnpm", executable}
	for _, argument := range prefix {
		startArguments = append(startArguments, "--pnpm-prefix", argument)
	}
	stdout, stderr, code = runCLICommand(t, binary, startArguments...)
	if code != 0 {
		t.Fatalf("dsh start: %s", stderr)
	}
	if !strings.Contains(stdout, "starting") {
		t.Fatalf("dsh start answered %s", stdout)
	}
	announced := ""
	for attempt := 0; attempt < 100 && announced == ""; attempt++ {
		stdout, _, _ = runCLICommand(t, binary, "status", "--state", state, "--json")
		if strings.Contains(stdout, "127.0.0.1:3099") {
			announced = stdout
		}
		time.Sleep(100 * time.Millisecond)
	}
	if announced == "" {
		t.Fatal("the headless runtime never announced its URL")
	}
	// With a child running, the proxy binding is the address a peer is handed:
	// the announced loopback URL and the first generation of it.
	stdout, stderr, code = runCLICommand(t, binary, "proxy", "--state", state, "--json")
	if code != 0 {
		t.Fatalf("proxy: %s", stderr)
	}
	var binding struct {
		Generation uint64 `json:"generation"`
		URL        string `json:"url"`
	}
	if json.Unmarshal([]byte(stdout), &binding) != nil || binding.Generation != 1 ||
		!strings.Contains(binding.URL, "127.0.0.1:3099") {
		t.Fatalf("proxy answered %s", stdout)
	}
	stdout, stderr, code = runCLICommand(t, binary, "proxy", "--state", state)
	if code != 0 || !strings.Contains(stdout, "proxy generation 1:") {
		t.Fatalf("proxy line = %q (%d) %s", stdout, code, stderr)
	}
	// The address is only useful if the hosted workbench answers there, so it is
	// opened the way a desktop peer opens it: one loopback request carrying the
	// token the host published. A 403 would mean the token never travelled.
	answer, getErr := http.Get(binding.URL)
	if getErr != nil {
		t.Fatalf("the published endpoint did not answer: %v", getErr)
	}
	body, readErr := io.ReadAll(answer.Body)
	answer.Body.Close()
	if readErr != nil || answer.StatusCode != http.StatusOK || !strings.Contains(string(body), "dsh-workbench") {
		t.Fatalf("workbench = %d %q (%v)", answer.StatusCode, body, readErr)
	}

	if stdout, stderr, code = runCLICommand(t, binary, "dsh", "stop", "--state", state); code != 0 {
		t.Fatalf("dsh stop: %s", stderr)
	}
	// With the child gone the binding is refused again rather than pointing at
	// an address that no longer answers.
	if _, stderr, code = runCLICommand(t, binary, "proxy", "--state", state); code != 1 ||
		strings.TrimSpace(stderr) != "p2p.runtime_unavailable" {
		t.Fatalf("proxy after a stop = %q (%d)", stderr, code)
	}
	// Stopping an already stopped launch reports the record rather than failing:
	// the subject is known, so this is not the unknown-subject refusal below.
	if !strings.Contains(stdout, "stopped") {
		t.Fatalf("second stop answered %s", stdout)
	}

	// Three distinct failures reach the terminal as three distinct codes.
	codes := map[string]string{
		"an unknown method":  "p2p.invalid_operation",
		"an unknown subject": "runtime.not_found",
	}
	for name, expected := range codes {
		_, stderr, code = runCLICommand(t, binary, "call", methodForCLI(name), payloadForCLI(name), "--state", state)
		if code != 1 || strings.TrimSpace(stderr) != expected {
			t.Errorf("%s = %q (%d), want %s", name, stderr, code, expected)
		}
	}

	// The pairing and connection commands reach the same host operations the
	// shell reaches, and their refusals are the host's own codes: nothing is
	// configured on this host, which is a different failure from the three above.
	_, stderr, code = runCLICommand(t, binary, "pair", "--service", "service_main", "--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.service_unconfigured" {
		t.Fatalf("pair = %q (%d)", stderr, code)
	}
	_, stderr, code = runCLICommand(t, binary, "connect", "--service", "service_main",
		"--pair", "pair_main", "--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.service_unconfigured" {
		t.Fatalf("connect = %q (%d)", stderr, code)
	}
	// A missing argument is refused before any call is made.
	if _, stderr, code = runCLICommand(t, binary, "connect", "--service", "service_main", "--state", state); code != 1 ||
		!strings.Contains(stderr, "p2p.invalid_arguments") {
		t.Fatalf("connect without a pair = %q (%d)", stderr, code)
	}

	// With the daemon gone the CLI reports the unreachable endpoint by name
	// instead of hanging or inventing an answer.
	stop()
	_, stderr, code = runCLICommand(t, binary, "status", "--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.helper_unavailable" {
		t.Fatalf("status after the daemon stopped = %q (%d)", stderr, code)
	}
}

// methodForCLI and payloadForCLI name the two distinguishable failures.
func methodForCLI(name string) string {
	if name == "an unknown method" {
		return "nope.nope"
	}
	return "runtime.stop"
}

func payloadForCLI(name string) string {
	if name == "an unknown method" {
		return "{}"
	}
	return `{"subjectId":"subject_absent"}`
}
