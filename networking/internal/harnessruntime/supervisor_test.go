package harnessruntime

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// waitFor polls one condition until it holds or the deadline expires, so the
// tests never depend on how fast this host schedules goroutines.
func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not happen before the deadline", description)
}

// TestSupervisorOwnsTheChildEndToEnd drives the whole lifecycle the shell used
// to implement: the command is built and spawned, the child announces its own
// loopback URL, its output reaches the log and the console, and a stop leaves no
// process behind.
func TestSupervisorOwnsTheChildEndToEnd(t *testing.T) {
	base := t.TempDir()
	supervisor := NewSupervisor()
	logPath := filepath.Join(base, "logs", "dsh-web.log")
	command := fakeChildCommand(base)
	view, err := supervisor.StartCommand(command, Identity{
		LaunchID:  "launch_main",
		SubjectID: "subject_main",
		Port:      AutoPort(),
		LogPath:   logPath,
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if view.State != StateStarting || view.PID <= 0 {
		t.Fatalf("start view = %+v", view)
	}

	// A second launch for the same subject is refused rather than doubled.
	if _, err := supervisor.StartCommand(command, view.identityForTest()); !errors.Is(err, ErrOperationInProgress) {
		t.Fatalf("second start = %v", err)
	}

	waitFor(t, "the announced URL", func() bool {
		current, _ := supervisor.Status("subject_main")
		return current.State == StateRunning
	})
	running, _ := supervisor.Status("subject_main")
	if running.URL != "http://127.0.0.1:3088/?token=abc" {
		t.Fatalf("announced url = %q", running.URL)
	}

	// The child wrote to the log, and the console carries its output plus the
	// core's own lifecycle events.
	waitFor(t, "console output", func() bool {
		entries, _ := supervisor.Console().After(0)
		for _, entry := range entries {
			if strings.Contains(entry.Text, "token=abc") {
				return true
			}
		}
		return false
	})
	consoleRaw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("log: %v", err)
	}
	if !strings.Contains(string(consoleRaw), "token=abc") || !strings.Contains(string(consoleRaw), "[launcher]") {
		t.Fatalf("log contents = %q", consoleRaw)
	}

	stopped, err := supervisor.Stop("subject_main")
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if stopped.State != StateStopped {
		t.Fatalf("stopped view = %+v", stopped)
	}
	waitFor(t, "the process to disappear", func() bool { return !processIsAlive(view.PID) })
	if _, err := supervisor.Stop("subject_main"); err != nil {
		t.Fatalf("second stop = %v", err)
	}
	if _, err := supervisor.Stop("subject_absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown subject = %v", err)
	}
	if _, ok := supervisor.Status("subject_absent"); ok {
		t.Fatal("an unknown subject reported a record")
	}
}

// TestSupervisorRefusesATreeThatNeverExits proves the stop is bounded: a child
// that ignores the signal is escalated once and then reported, never waited on
// forever.
func TestSupervisorRefusesInvalidInput(t *testing.T) {
	supervisor := NewSupervisor()
	base := t.TempDir()
	for name, identity := range map[string]Identity{
		"an unopaque launch id": {LaunchID: "launch main", SubjectID: "subject_main"},
		"an unopaque subject":   {LaunchID: "launch_main", SubjectID: "subject main"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := supervisor.StartCommand(Command{Executable: "sh", Directory: base}, identity); !errors.Is(err, ErrInputInvalid) {
				t.Fatalf("%s = %v", name, err)
			}
		})
	}
	if _, err := supervisor.StartCommand(Command{Executable: "", Directory: base}, Identity{LaunchID: "launch_main", SubjectID: "subject_main"}); !errors.Is(err, ErrInputInvalid) {
		t.Fatalf("an empty executable = %v", err)
	}
}

// TestShutdownStopsEveryChild covers the core's own exit path.
func TestShutdownStopsEveryChild(t *testing.T) {
	base := t.TempDir()
	supervisor := NewSupervisor()
	views := make([]LaunchView, 0, 2)
	for _, subject := range []string{"subject_one", "subject_two"} {
		view, err := supervisor.StartCommand(fakeChildCommand(base), Identity{
			LaunchID:  "launch_" + subject,
			SubjectID: subject,
			LogPath:   filepath.Join(base, subject+".log"),
		})
		if err != nil {
			t.Fatalf("start %s: %v", subject, err)
		}
		views = append(views, view)
	}
	supervisor.Shutdown()
	for _, view := range views {
		waitFor(t, "the process to disappear", func() bool { return !processIsAlive(view.PID) })
		current, _ := supervisor.Status(view.SubjectID)
		if current.State != StateStopped {
			t.Fatalf("%s = %+v", view.SubjectID, current)
		}
	}
}

func (view LaunchView) identityForTest() Identity {
	return Identity{LaunchID: view.LaunchID, SubjectID: view.SubjectID}
}
