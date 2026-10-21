//go:build windows

package harnessruntime

import (
	"debug/pe"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

type windowsConsoleReceipt struct {
	Kind                string   `json:"kind"`
	PID                 int      `json:"pid"`
	ParentPID           int      `json:"parentPid"`
	ConsoleWindow       uintptr  `json:"consoleWindow"`
	ConsoleProcessCount uint32   `json:"consoleProcessCount"`
	ConsoleProcessIDs   []uint32 `json:"consoleProcessIds"`
	ConsoleError        uint32   `json:"consoleError"`
}

// Check admission before executing any console-subsystem program. The original
// attributes fail here, so testing the regression never deliberately opens a UI.
func requireWindowsBackgroundAdmission(t *testing.T) {
	t.Helper()
	attrs := processGroupAttributes()
	if attrs == nil || !attrs.HideWindow || attrs.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("managed runtime attributes allow an interactive console")
	}
	command := backgroundCommand("not-executed")
	attrs = command.SysProcAttr
	if attrs == nil || !attrs.HideWindow || attrs.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("background system command attributes allow an interactive console")
	}
}

func buildWindowsConsoleProbe(t *testing.T) string {
	t.Helper()
	requireWindowsBackgroundAdmission(t)
	output := filepath.Join(t.TempDir(), "console-probe.exe")
	build := backgroundCommand("go", "build", "-trimpath", "-o", output, "./testdata/windows-console-probe")
	if result, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build real Windows console probe: %v\n%s", err, result)
	}
	image, err := pe.Open(output)
	if err != nil {
		t.Fatal(err)
	}
	defer image.Close()
	var subsystem uint16
	switch header := image.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		subsystem = header.Subsystem
	case *pe.OptionalHeader64:
		subsystem = header.Subsystem
	default:
		t.Fatal("probe has no supported PE optional header")
	}
	if subsystem != pe.IMAGE_SUBSYSTEM_WINDOWS_CUI {
		t.Fatal("probe must exercise a real console-subsystem executable", subsystem)
	}
	return output
}

func assertNoWindowsConsole(t *testing.T, receipt windowsConsoleReceipt, parentPID int) {
	t.Helper()
	if receipt.PID <= 0 || receipt.ParentPID != parentPID || receipt.ConsoleWindow != 0 {
		t.Fatal("background child has a Windows console window or lost its process identity", receipt)
	}
	// CREATE_NO_WINDOW can still report console process-list membership. Preserve
	// that separate kernel observation without treating a count as a window HWND.
	t.Logf("kernel-console-receipt: %+v", receipt)
}

func supervisorProbeReceipts(supervisor *Supervisor, after int64) (map[string]windowsConsoleReceipt, string) {
	entries, _ := supervisor.Console().After(after)
	var stdout, stderr strings.Builder
	for _, entry := range entries {
		switch entry.Stream {
		case StreamStdout:
			stdout.WriteString(entry.Text)
		case StreamStderr:
			stderr.WriteString(entry.Text)
		}
	}
	receipts := map[string]windowsConsoleReceipt{}
	for _, line := range strings.Split(stdout.String(), "\n") {
		var receipt windowsConsoleReceipt
		if json.Unmarshal([]byte(line), &receipt) == nil && receipt.PID > 0 {
			receipts[receipt.Kind] = receipt
		}
	}
	return receipts, stderr.String()
}

func TestWindowsBackgroundSupervisorHasNoConsoleAndPreservesLifecycle(t *testing.T) {
	probe := buildWindowsConsoleProbe(t)
	supervisor := NewSupervisor()
	t.Cleanup(supervisor.Shutdown)
	base := t.TempDir()
	logPath := filepath.Join(base, "runtime.log")
	var previousLaunchID string
	for attempt := range 2 {
		cursor := supervisor.Console().Latest()
		identity := Identity{LaunchID: fmt.Sprintf("console_launch_%d", attempt), SubjectID: "console_subject", Port: AutoPort(), LogPath: logPath}
		view, err := supervisor.StartCommand(Command{Executable: probe, Arguments: []string{"tree"}, Directory: base}, identity)
		if err != nil {
			t.Fatal("start hidden console-subsystem child", err)
		}
		if view.PID <= 0 || view.LaunchID == previousLaunchID || view.LaunchID != identity.LaunchID || view.State != StateStarting {
			t.Fatal("start lost its exact new process and launch identity", view)
		}
		waitFor(t, "real child and descendant console receipts plus stderr", func() bool {
			receipts, stderr := supervisorProbeReceipts(supervisor, cursor)
			return len(receipts) == 2 && strings.Count(stderr, "console-probe stderr pid=") == 2
		})
		receipts, stderr := supervisorProbeReceipts(supervisor, cursor)
		root, leaf := receipts["tree"], receipts["leaf"]
		assertNoWindowsConsole(t, root, os.Getpid())
		assertNoWindowsConsole(t, leaf, root.PID)
		if root.PID != view.PID || leaf.PID == root.PID || !strings.Contains(stderr, fmt.Sprintf("pid=%d", leaf.PID)) {
			t.Fatal("pipes changed the exact supervised process tree identity", receipts, view)
		}
		data, err := os.ReadFile(logPath)
		if err != nil || !strings.Contains(string(data), fmt.Sprintf(`"pid":%d`, root.PID)) || !strings.Contains(string(data), fmt.Sprintf(`"pid":%d`, leaf.PID)) || !strings.Contains(string(data), "console-probe stderr") {
			t.Fatal("hidden process lost stdout or stderr in the real launch log", string(data), err)
		}
		stopped, err := supervisor.Stop(identity.SubjectID)
		if err != nil || stopped.State != StateStopped || stopped.PID != root.PID || stopped.LaunchID != identity.LaunchID || stopped.Diagnostics.ExitCode == nil {
			t.Fatal("hidden process stop did not retain its exact Wait receipt", stopped, err)
		}
		waitFor(t, "both exact owned process IDs to exit", func() bool { return !processIsAlive(root.PID) && !processIsAlive(leaf.PID) })
		if stoppedAgain, err := supervisor.Stop(identity.SubjectID); err != nil || stoppedAgain.PID != root.PID || stoppedAgain.State != StateStopped {
			t.Fatal("repeated stop lost its completed process identity", stoppedAgain, err)
		}
		previousLaunchID = view.LaunchID
	}
}

func TestWindowsBackgroundSystemCommandRunnerHasNoConsole(t *testing.T) {
	probe := buildWindowsConsoleProbe(t)
	output, err := SystemCommandRunner(probe, []string{"once"})
	if err != nil {
		t.Fatal("run hidden real system command", err)
	}
	var receipt windowsConsoleReceipt
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &receipt); err != nil || receipt.Kind != "once" {
		t.Fatal("system command stdout no longer contains its real receipt", output, err)
	}
	assertNoWindowsConsole(t, receipt, os.Getpid())
	if processIsAlive(receipt.PID) {
		t.Fatal("completed system command still has a live process", receipt.PID)
	}
	_, err = SystemCommandRunner(probe, []string{"fail"})
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 7 || !strings.Contains(string(exit.Stderr), "console-probe requested failure") {
		t.Fatal("hidden command lost its original failure code or stderr", err)
	}
}

func TestWindowsBackgroundSpawnFailureKeepsTypedError(t *testing.T) {
	requireWindowsBackgroundAdmission(t)
	supervisor := NewSupervisor()
	t.Cleanup(supervisor.Shutdown)
	base := t.TempDir()
	_, err := supervisor.StartCommand(Command{Executable: filepath.Join(base, "missing.exe"), Directory: base}, Identity{LaunchID: "missing_launch", SubjectID: "missing_subject", LogPath: filepath.Join(base, "launch.log")})
	if !errors.Is(err, ErrSpawnFailed) {
		t.Fatal("hidden launch replaced the typed missing-process refusal", err)
	}
	if _, exists := supervisor.Status("missing_subject"); exists {
		t.Fatal("failed hidden launch published an owned process")
	}
}
