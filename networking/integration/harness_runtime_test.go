package integration

// Task 4.3 to 4.5: the core owns the DSH Web child. This drives the real daemon
// over the real private channel, because the child, its refusal codes and its
// console feed all have to survive that boundary: a runtime.* code that
// collapsed on the way would reach the shell as an unexplained failure.
import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
)

// writeFakeLauncher writes a stand-in pnpm that ignores the DSH arguments and
// announces the loopback URL the real child prints.
func writeFakeLauncher(t *testing.T, base string) (string, []string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		script := filepath.Join(base, "fake-pnpm.bat")
		// The announced token is the same on both platforms: the assertions below
		// name one value, and a fixture that announced a different one failed on
		// Windows for a reason that had nothing to do with the daemon.
		body := "@echo off\r\necho dsh web: http://127.0.0.1:3099/?token=daemon\r\nping -n 30 127.0.0.1 > nul\r\n"
		if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return os.Getenv("COMSPEC"), []string{"/c", script}
	}
	script := filepath.Join(base, "fake-pnpm")
	body := "#!/bin/sh\necho 'dsh web: http://127.0.0.1:3099/?token=daemon'\nexec sleep 30\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return "/bin/sh", []string{script}
}

func TestCoreDaemonOwnsTheHarnessRuntime(t *testing.T) {
	parent, stopCore := startCoreDaemon(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_callback")
	})
	defer stopCore()
	ctx := context.Background()
	base := t.TempDir()
	executable, prefix := writeFakeLauncher(t, base)
	encoded, err := json.Marshal(struct {
		LaunchID              string   `json:"launchId"`
		SubjectID             string   `json:"subjectId"`
		Directory             string   `json:"directory"`
		Profile               string   `json:"profile"`
		NodeExecutable        string   `json:"nodeExecutable"`
		PnpmExecutable        string   `json:"pnpmExecutable"`
		PnpmPrefixArguments   []string `json:"pnpmPrefixArguments"`
		PnpmResolutionError   string   `json:"pnpmResolutionError"`
		PnpmCommandSearchPath string   `json:"pnpmCommandSearchPath"`
		DiagnosticsPatchPath  string   `json:"diagnosticsPatchPath"`
		Port                  struct {
			Mode string `json:"mode"`
		} `json:"port"`
		LogPath string `json:"logPath"`
	}{
		LaunchID:             "launch_main",
		SubjectID:            "subject_main",
		Directory:            base,
		Profile:              harnessruntime.ProfilePnpm,
		PnpmExecutable:       executable,
		PnpmPrefixArguments:  prefix,
		DiagnosticsPatchPath: filepath.Join(base, "patch.yml"),
		Port: struct {
			Mode string `json:"mode"`
		}{Mode: "auto"},
		LogPath: filepath.Join(base, "dsh-web.log"),
	})
	if err != nil {
		t.Fatal(err)
	}
	// A payload crosses the frame as JSON, not as a base64 string, so the raw
	// message is what the peer call carries.
	request := json.RawMessage(encoded)

	// A subject that has never run is refused by name rather than reported.
	if _, err := parent.Call(ctx, "runtime.stop", json.RawMessage(`{"subjectId":"subject_absent"}`)); err == nil || err.Error() != "runtime.not_found" {
		t.Fatalf("unknown subject = %v", err)
	}
	status, err := parent.Call(ctx, "runtime.status", json.RawMessage(`{"subjectId":"subject_main"}`))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	var absent struct {
		Present bool `json:"present"`
	}
	if json.Unmarshal(status, &absent) != nil || absent.Present {
		t.Fatalf("status before a launch = %s", status)
	}

	started, err := parent.Call(ctx, "runtime.start", request)
	if err != nil {
		t.Fatalf("start: %v (payload %s)", err, request)
	}
	var launch struct {
		Launch struct {
			State string `json:"state"`
			PID   int    `json:"pid"`
			URL   string `json:"url"`
		} `json:"launch"`
	}
	if json.Unmarshal(started, &launch) != nil || launch.Launch.PID <= 0 {
		t.Fatalf("start answered %s", started)
	}
	pid := launch.Launch.PID

	// The same subject cannot be doubled, and the refusal crosses unchanged.
	if _, err := parent.Call(ctx, "runtime.start", request); err == nil || err.Error() != "runtime.operation_in_progress" {
		t.Fatalf("second start = %v", err)
	}

	announced := ""
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) && announced == "" {
		answer, err := parent.Call(ctx, "runtime.status", json.RawMessage(`{"subjectId":"subject_main"}`))
		if err != nil {
			t.Fatalf("status: %v", err)
		}
		var view struct {
			Launch struct {
				State string `json:"state"`
				URL   string `json:"url"`
			} `json:"launch"`
		}
		if json.Unmarshal(answer, &view) != nil {
			t.Fatalf("status answered %s", answer)
		}
		announced = view.Launch.URL
		if announced == "" {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if announced != "http://127.0.0.1:3099/?token=daemon" {
		t.Fatalf("announced url = %q", announced)
	}

	consoleAnswer, err := parent.Call(ctx, "runtime.console", json.RawMessage(`{"cursor":0}`))
	if err != nil {
		t.Fatalf("console: %v", err)
	}
	if !strings.Contains(string(consoleAnswer), "token=daemon") {
		t.Fatalf("console answered %s", consoleAnswer)
	}

	stopped, err := parent.Call(ctx, "runtime.stop", json.RawMessage(`{"subjectId":"subject_main"}`))
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if !strings.Contains(string(stopped), "stopped") {
		t.Fatalf("stop answered %s", stopped)
	}
	// The child really is gone, not merely marked stopped.
	for attempt := 0; attempt < 100; attempt++ {
		if !processRunning(pid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid %d survived the stop", pid)
}

// processRunning reports whether one process still exists, using the signal zero
// probe the port check already relies on.
func processRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return process.Signal(syscall.Signal(0)) == nil
}
