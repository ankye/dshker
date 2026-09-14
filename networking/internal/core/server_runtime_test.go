package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
)

// fakeLauncher writes a stand-in pnpm that ignores the DSH arguments, announces
// the loopback URL the real child prints, and stays alive until it is stopped.
func fakeLauncher(t *testing.T, base string) (string, []string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		script := filepath.Join(base, "fake-pnpm.bat")
		body := "@echo off\r\necho $ dsh web --no-open 1>&2\r\necho dsh web: http://127.0.0.1:3099/?token=fake\r\nping -n 30 127.0.0.1 > nul\r\n"
		if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return os.Getenv("COMSPEC"), []string{"/c", script}
	}
	script := filepath.Join(base, "fake-pnpm")
	body := "#!/bin/sh\necho '$ dsh web --no-open' 1>&2\necho 'dsh web: http://127.0.0.1:3099/?token=fake'\nexec sleep 30\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return "/bin/sh", []string{script}
}

// startPayload renders a complete launch request. Every field is present because
// this channel decodes strictly: a missing field is a refusal, never a default.
func startPayload(t *testing.T, base, executable string, prefix []string, port string) json.RawMessage {
	t.Helper()
	prefixJSON, err := json.Marshal(prefix)
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(fmt.Sprintf(
		"{\"launchId\":\"launch_main\",\"subjectId\":\"subject_main\",\"directory\":%q,"+
			"\"pnpmExecutable\":%q,\"pnpmPrefixArguments\":%s,\"pnpmResolutionError\":\"\","+
			"\"pnpmCommandSearchPath\":\"\",\"diagnosticsPatchPath\":%q,\"port\":%s,\"logPath\":%q}",
		base, executable, prefixJSON, filepath.Join(base, "verbose.patch.yml"), port,
		filepath.Join(base, "logs", "dsh-web.log"),
	))
}

func portPayload(filePath string, port *harnessruntime.PortSetting) json.RawMessage {
	if port == nil {
		return json.RawMessage(fmt.Sprintf("{\"filePath\":%q}", filePath))
	}
	encoded, err := json.Marshal(struct {
		FilePath string                      `json:"filePath"`
		Port     *harnessruntime.PortSetting `json:"port"`
	}{FilePath: filePath, Port: port})
	if err != nil {
		panic(err)
	}
	return encoded
}

// TestRuntimePortPreferencesAreOwnedByTheCore drives the document the shell used
// to write: a missing record invites a choice, and a saved one round-trips.
func TestRuntimePortPreferencesAreOwnedByTheCore(t *testing.T) {
	base := t.TempDir()
	filePath := filepath.Join(base, harnessruntime.PreferencesFileName)
	server := Serve{Runtime: harnessruntime.NewSupervisor()}

	loaded, err := server.Handle(context.Background(), "runtime.port_get", portPayload(filePath, nil))
	if err != nil {
		t.Fatalf("port_get: %v", err)
	}
	if result, ok := loaded.(runtimePortResult); !ok || result.Port.Mode != "auto" {
		t.Fatalf("missing document = %+v", loaded)
	}

	fixed := harnessruntime.PortSetting{Mode: "fixed", Port: 3088}
	if _, err := server.Handle(context.Background(), "runtime.port_set", portPayload(filePath, &fixed)); err != nil {
		t.Fatalf("port_set: %v", err)
	}
	readback, err := server.Handle(context.Background(), "runtime.port_get", portPayload(filePath, nil))
	if err != nil {
		t.Fatalf("port_get: %v", err)
	}
	if result, ok := readback.(runtimePortResult); !ok || result.Port.Port != 3088 {
		t.Fatalf("readback = %+v", readback)
	}
	raw, err := os.ReadFile(filePath)
	if err != nil || !strings.Contains(string(raw), "dsh-launcher.launch-preferences") {
		t.Fatalf("persisted = %q, %v", raw, err)
	}

	privileged := harnessruntime.PortSetting{Mode: "fixed", Port: 80}
	if _, err := server.Handle(context.Background(), "runtime.port_set", portPayload(filePath, &privileged)); !errors.Is(err, harnessruntime.ErrInputInvalid) {
		t.Fatalf("privileged port = %v", err)
	}

	// The path is not a caller's choice: only the one file name is owned.
	if _, err := server.Handle(context.Background(), "runtime.port_get", portPayload(filepath.Join(base, "preferences.json"), nil)); !errors.Is(err, harnessruntime.ErrPreferencesFailed) {
		t.Fatalf("another file name = %v", err)
	}
}

// TestRuntimeStartStopThroughTheCore drives the whole child lifecycle over the
// private channel: the command is built, the child announces its URL, the
// console feed is drained by cursor, and the stop leaves nothing behind.
func TestRuntimeStartStopThroughTheCore(t *testing.T) {
	base := t.TempDir()
	executable, prefix := fakeLauncher(t, base)
	server := Serve{Runtime: harnessruntime.NewSupervisor()}
	ctx := context.Background()
	started, err := server.Handle(ctx, "runtime.start", startPayload(t, base, executable, prefix, `{"mode":"auto"}`))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	launch, ok := started.(runtimeResult)
	if !ok || launch.Launch == nil || launch.Launch.PID <= 0 {
		t.Fatalf("start = %+v", started)
	}
	pid := launch.Launch.PID
	defer func() { _, _ = server.Handle(ctx, "runtime.stop", json.RawMessage(`{"subjectId":"subject_main"}`)) }()

	// The same subject cannot be started twice.
	if _, err := server.Handle(ctx, "runtime.start", startPayload(t, base, executable, prefix, `{"mode":"auto"}`)); !errors.Is(err, harnessruntime.ErrOperationInProgress) {
		t.Fatalf("second start = %v", err)
	}

	var running harnessruntime.LaunchView
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		answer, err := server.Handle(ctx, "runtime.status", json.RawMessage(`{"subjectId":"subject_main"}`))
		if err != nil {
			t.Fatalf("status: %v", err)
		}
		status, ok := answer.(runtimeStatusResult)
		if !ok || !status.Present || status.Launch == nil {
			t.Fatalf("status = %+v", answer)
		}
		running = *status.Launch
		if running.State == harnessruntime.StateRunning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if running.State != harnessruntime.StateRunning || running.URL != "http://127.0.0.1:3099/?token=fake" {
		t.Fatalf("running = %+v", running)
	}

	consoleAnswer, err := server.Handle(ctx, "runtime.console", json.RawMessage(`{"cursor":0}`))
	if err != nil {
		t.Fatalf("console: %v", err)
	}
	entries, ok := consoleAnswer.(runtimeConsoleResult)
	if !ok || entries.Cursor == 0 {
		t.Fatalf("console = %+v", consoleAnswer)
	}
	drained := false
	for _, entry := range entries.Entries {
		if strings.Contains(entry.Text, "token=fake") {
			drained = true
		}
	}
	if !drained {
		t.Fatalf("console lost the child output: %+v", entries.Entries)
	}
	// A cursor at the newest sequence has nothing left to deliver.
	again, err := server.Handle(ctx, "runtime.console", json.RawMessage(`{"cursor":`+strconv.FormatInt(entries.Cursor, 10)+`}`))
	if err != nil {
		t.Fatalf("console: %v", err)
	}
	if more, ok := again.(runtimeConsoleResult); !ok || len(more.Entries) != 0 {
		t.Fatalf("a drained cursor returned %+v", again)
	}

	stopped, err := server.Handle(ctx, "runtime.stop", json.RawMessage(`{"subjectId":"subject_main"}`))
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if view, ok := stopped.(runtimeResult); !ok || view.Launch == nil || view.Launch.State != harnessruntime.StateStopped {
		t.Fatalf("stop = %+v", stopped)
	}
	if harnessruntime.ProcessAlive(pid) {
		t.Fatalf("pid %d survived the stop", pid)
	}
	if _, err := server.Handle(ctx, "runtime.stop", json.RawMessage(`{"subjectId":"subject_absent"}`)); !errors.Is(err, harnessruntime.ErrNotFound) {
		t.Fatalf("unknown subject = %v", err)
	}
}

// TestRuntimeMethodsNeedAProcessAuthority keeps the refusal honest: a core built
// without a supervisor does not pretend the child is somewhere else.
func TestRuntimeMethodsNeedAProcessAuthority(t *testing.T) {
	payloads := map[string]string{
		"runtime.start":   `{"launchId":"launch_main","subjectId":"subject_main","directory":"/tmp","pnpmExecutable":"/bin/sh","pnpmPrefixArguments":[],"pnpmResolutionError":"","pnpmCommandSearchPath":"","diagnosticsPatchPath":"/tmp/patch","port":{"mode":"auto"},"logPath":"/tmp/log"}`,
		"runtime.stop":    `{"subjectId":"subject_main"}`,
		"runtime.status":  `{"subjectId":"subject_main"}`,
		"runtime.console": `{"cursor":0}`,
	}
	for method, payload := range payloads {
		if _, err := Handle(context.Background(), method, json.RawMessage(payload)); err == nil || err.Error() != "p2p.not_implemented" {
			t.Errorf("Handle(%q) = %v", method, err)
		}
	}
}

func TestRuntimeRejectsMalformedPayloads(t *testing.T) {
	server := Serve{Runtime: harnessruntime.NewSupervisor()}
	for name, payload := range map[string]string{
		"an unknown field": `{"subjectId":"subject_main","extra":1}`,
		"a missing field":  `{}`,
		"not an object":    "[]",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := server.Handle(context.Background(), "runtime.status", json.RawMessage(payload)); err == nil {
				t.Fatalf("%s was accepted", payload)
			}
		})
	}
}
