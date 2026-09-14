package harnessruntime

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// listeningLsof and listeningNetstat are the exact shapes the two platform tools
// print, so the parsers are exercised on real output rather than on invented
// columns.
const listeningLsof = "COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n" +
	"node     9001 ankye   23u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:3088 (LISTEN)\n"

const listeningNetstat = "  TCP    127.0.0.1:3088         0.0.0.0:0              LISTENING       9001\n" +
	"  TCP    127.0.0.1:30881        0.0.0.0:0              LISTENING       9100\n"

func TestParseLsofListenPID(t *testing.T) {
	pid, ok := ParseLsofListenPID(listeningLsof)
	if !ok || pid != 9001 {
		t.Fatalf("lsof = %d, %v", pid, ok)
	}
	if _, ok := ParseLsofListenPID("COMMAND   PID   USER\n"); ok {
		t.Fatal("an empty listing reported a holder")
	}
}

func TestParseNetstatListenPID(t *testing.T) {
	pid, ok := ParseNetstatListenPID(listeningNetstat, 3088)
	if !ok || pid != 9001 {
		t.Fatalf("netstat = %d, %v", pid, ok)
	}
	// A listening port whose digits merely start with the wanted ones is not it.
	if pid, ok := ParseNetstatListenPID(listeningNetstat, 30881); !ok || pid != 9100 {
		t.Fatalf("netstat = %d, %v", pid, ok)
	}
	if _, ok := ParseNetstatListenPID(listeningNetstat, 9999); ok {
		t.Fatal("a port nobody listens on reported a holder")
	}
}

// TestFindPortOccupantReadsTheCommandLine covers both platform rules end to end,
// including the Windows fallback for a host where wmic is gone.
func TestFindPortOccupantReadsTheCommandLine(t *testing.T) {
	posix := func(executable string, arguments []string) (string, error) {
		if executable == "lsof" {
			return listeningLsof, nil
		}
		if executable == "ps" && strings.Join(arguments, " ") == "-p 9001 -o command=" {
			return "/opt/dsh/apps/cli/lib/bin.js web --no-open\n", nil
		}
		return "", errors.New("unexpected command")
	}
	occupant, found := FindPortOccupant(3088, "darwin", posix)
	if !found || occupant.PID != 9001 || !strings.Contains(occupant.CommandLine, "bin.js web") {
		t.Fatalf("posix occupant = %+v, %v", occupant, found)
	}

	windows := func(executable string, arguments []string) (string, error) {
		switch executable {
		case "netstat":
			return listeningNetstat, nil
		case "wmic":
			return "", errors.New("wmic is not available")
		case "powershell":
			return "node C:\\dsh\\apps\\cli\\lib\\bin.js web --no-open\n", nil
		}
		return "", errors.New("unexpected command")
	}
	occupant, found = FindPortOccupant(3088, "windows", windows)
	if !found || occupant.PID != 9001 || !strings.Contains(occupant.CommandLine, "bin.js web") {
		t.Fatalf("windows occupant = %+v, %v", occupant, found)
	}

	triedFallback := false
	unreadable := func(executable string, arguments []string) (string, error) {
		if executable == "netstat" {
			return listeningNetstat, nil
		}
		if executable == "powershell" {
			triedFallback = true
		}
		return "", errors.New("unavailable")
	}
	occupant, found = FindPortOccupant(3088, "windows", unreadable)
	if !found || occupant.CommandLine != "" || !triedFallback {
		t.Fatalf("unreadable occupant = %+v, %v", occupant, found)
	}
}

// TestPreparePortForLaunchMirrorsTheShellDecision covers the three outcomes the
// shell produced before the core owned the child.
func TestPreparePortForLaunchMirrorsTheShellDecision(t *testing.T) {
	free := PreparePortForLaunch(3088, "darwin", PortPreparation{
		Run: func(string, []string) (string, error) { return "", errors.New("nothing listens") },
	})
	if free.Kind != PortFree {
		t.Fatalf("free = %+v", free)
	}

	terminated := 0
	cleared := PreparePortForLaunch(3088, "darwin", PortPreparation{
		Run: func(executable string, arguments []string) (string, error) {
			if executable == "lsof" {
				return listeningLsof, nil
			}
			return "/opt/dsh/apps/cli/lib/bin.js web --no-open\n", nil
		},
		Terminate: func(pid int) error {
			terminated = pid
			return nil
		},
	})
	if cleared.Kind != PortCleared || cleared.PID != 9001 || terminated != 9001 {
		t.Fatalf("cleared = %+v, terminated %d", cleared, terminated)
	}

	foreign := PreparePortForLaunch(3088, "darwin", PortPreparation{
		Run: func(executable string, arguments []string) (string, error) {
			if executable == "lsof" {
				return listeningLsof, nil
			}
			return "/srv/api/server.js --port 3088\n", nil
		},
		Terminate: func(int) error {
			t.Fatal("a foreign holder was terminated")
			return nil
		},
	})
	if foreign.Kind != PortForeign || foreign.Occupant == nil || foreign.Occupant.PID != 9001 {
		t.Fatalf("foreign = %+v", foreign)
	}
	if err := ForeignPortFailure(3088, *foreign.Occupant); !errors.Is(err, ErrPortInUse) {
		t.Fatalf("refusal = %v", err)
	}
}

// TestTerminatePortOccupantWaitsThenEscalates pins the bounded wait: a process
// that disappears on the request is never forced, and one that stays is
// escalated exactly once.
func TestTerminatePortOccupantWaitsThenEscalates(t *testing.T) {
	clock := time.Unix(0, 0)
	advance := func() time.Time {
		clock = clock.Add(time.Millisecond)
		return clock
	}
	gone := false
	observations := 0
	forced := false
	deps := PortTerminationDependencies{
		Terminate: func(int) error { return nil },
		Force:     func(int) error { forced = true; return nil },
		IsAlive: func(int) bool {
			observations++
			return !gone && observations > 1
		},
		Wait:   func(int) {},
		Budget: 5 * time.Millisecond,
		Now:    advance,
	}
	if err := TerminatePortOccupant(9001, deps); err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if forced {
		t.Fatal("a process that disappeared was forced")
	}

	clock = time.Unix(0, 0)
	observations = 0
	forced = false
	stillThere := PortTerminationDependencies{
		Terminate: func(int) error { return nil },
		Force:     func(int) error { forced = true; return nil },
		IsAlive:   func(int) bool { return true },
		Wait:      func(int) {},
		Budget:    5 * time.Millisecond,
		Now:       advance,
	}
	if err := TerminatePortOccupant(9001, stillThere); err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if !forced {
		t.Fatal("a process that never went away was not forced")
	}
	_ = gone
}

// TestForeignPortFailureNamesTheHolder covers the message the renderer shows.
func TestForeignPortFailureNamesTheHolder(t *testing.T) {
	named := ForeignPortFailure(3088, PortOccupant{PID: 9001, CommandLine: "node /srv/api/server.js"})
	if !errors.Is(named, ErrPortInUse) || !strings.Contains(named.Error(), "pid 9001") {
		t.Fatalf("named = %v", named)
	}
	anonymous := ForeignPortFailure(3088, PortOccupant{PID: 9001})
	if !strings.Contains(anonymous.Error(), "pid 9001") || strings.Contains(anonymous.Error(), "(") {
		t.Fatalf("anonymous = %v", anonymous)
	}
}
