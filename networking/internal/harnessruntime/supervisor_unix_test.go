//go:build !windows

package harnessruntime

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// fakeChildCommand is a stand-in DSH Web process: it echoes pnpm's script line,
// announces the loopback URL DSH prints, and then stays alive until it is
// stopped.
func fakeChildCommand(base string) Command {
	return Command{
		Executable: "/bin/sh",
		Arguments:  []string{"-c", "echo '$ dsh web --no-open' 1>&2; echo 'dsh web: http://127.0.0.1:3088/?token=abc'; exec sleep 30"},
		Directory:  base,
	}
}

// TestStopLeavesNoGrandchild proves the supervision is a tree kill rather than a
// signal to one process: the fake child starts its own child and records both
// pids, and neither may survive the stop.
func TestStopLeavesNoGrandchild(t *testing.T) {
	base := t.TempDir()
	pidFile := filepath.Join(base, "pids")
	supervisor := NewSupervisor()
	view, err := supervisor.StartCommand(Command{
		Executable: "/bin/sh",
		Arguments:  []string{"-c", "echo $$ > '" + pidFile + "'; sleep 40 & echo $! >> '" + pidFile + "'; wait"},
		Directory:  base,
	}, Identity{LaunchID: "launch_main", SubjectID: "subject_main", LogPath: filepath.Join(base, "child.log")})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var childPID, grandchildPID int
	waitFor(t, "both pids", func() bool {
		data, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		fields := strings.Fields(string(data))
		if len(fields) < 2 {
			return false
		}
		childPID, _ = strconv.Atoi(fields[0])
		grandchildPID, _ = strconv.Atoi(fields[1])
		return childPID > 0 && grandchildPID > 0
	})
	if !processIsAlive(grandchildPID) {
		t.Fatalf("the grandchild was not running to begin with")
	}
	if _, err := supervisor.Stop("subject_main"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	waitFor(t, "the whole tree to disappear", func() bool {
		return !processIsAlive(childPID) && !processIsAlive(grandchildPID)
	})
	if view.PID != childPID {
		t.Fatalf("the supervisor recorded pid %d, not the child pid %d", view.PID, childPID)
	}
}
