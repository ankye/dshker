package harnessruntime

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// PortOccupant is one process listening on a port, with the command line this
// process could read. A command line that could not be read is reported as
// unknown rather than guessed, because the adoption rule depends on it.
type PortOccupant struct {
	PID         int    `json:"pid"`
	CommandLine string `json:"commandLine,omitempty"`
}

// Port decision kinds. A leftover DSH Web process is adopted; any other holder
// is a refusal the renderer explains rather than a launch failure.
const (
	PortFree    = "free"
	PortCleared = "cleared"
	PortForeign = "foreign"
)

// PortDecision is the outcome of preparing one fixed port before a launch.
type PortDecision struct {
	Kind     string        `json:"kind"`
	PID      int           `json:"pid,omitempty"`
	Occupant *PortOccupant `json:"occupant,omitempty"`
}

// CommandRunner runs one bounded helper command and returns its standard output.
type CommandRunner func(executable string, arguments []string) (string, error)

// SystemCommandRunner is the production runner for the platform tools the port
// check needs.
func SystemCommandRunner(executable string, arguments []string) (string, error) {
	output, err := exec.Command(executable, arguments...).Output()
	return string(output), err
}

// ProcessAlive reports whether one process still exists. It is exported for the
// launch view and the headless CLI, neither of which may claim a stop it cannot
// observe.
func ProcessAlive(pid int) bool { return processIsAlive(pid) }

// FindPortOccupant reads the process listening on a port, or reports that
// nothing is. The platform argument is explicit so the two rules can be tested
// from either host.
func FindPortOccupant(port int, platform string, run CommandRunner) (PortOccupant, bool) {
	if platform == "windows" {
		return findWindowsPortOccupant(port, run)
	}
	return findPosixPortOccupant(port, run)
}

func findPosixPortOccupant(port int, run CommandRunner) (PortOccupant, bool) {
	listing, err := run("lsof", []string{"-nP", "-iTCP:" + strconv.Itoa(port), "-sTCP:LISTEN"})
	if err != nil {
		// lsof exits non-zero when nothing listens; that is the free case.
		return PortOccupant{}, false
	}
	pid, ok := ParseLsofListenPID(listing)
	if !ok {
		return PortOccupant{}, false
	}
	return PortOccupant{PID: pid, CommandLine: readPosixCommandLine(pid, run)}, true
}

func readPosixCommandLine(pid int, run CommandRunner) string {
	output, err := run("ps", []string{"-p", strconv.Itoa(pid), "-o", "command="})
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func findWindowsPortOccupant(port int, run CommandRunner) (PortOccupant, bool) {
	netstat, err := run("netstat", []string{"-ano"})
	if err != nil {
		return PortOccupant{}, false
	}
	pid, ok := ParseNetstatListenPID(netstat, port)
	if !ok {
		return PortOccupant{}, false
	}
	return PortOccupant{PID: pid, CommandLine: readWindowsCommandLine(pid, run)}, true
}

// readWindowsCommandLine reads one process command line. wmic was the original
// source and is absent from current Windows releases, where a missing command
// line would turn an adoptable leftover DSH Web process into a refusal forever,
// so PowerShell's CIM query is the fallback.
func readWindowsCommandLine(pid int, run CommandRunner) string {
	output, err := run("wmic", []string{"process", "where", "processid=" + strconv.Itoa(pid), "get", "commandline", "/format:list"})
	if err == nil {
		if command := strings.TrimSpace(output); command != "" {
			return command
		}
	}
	query := "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + strconv.Itoa(pid) + "').CommandLine"
	fallback, fallbackErr := run("powershell", []string{"-NoProfile", "-NonInteractive", "-Command", query})
	if fallbackErr != nil {
		return ""
	}
	return strings.TrimSpace(fallback)
}

// ParseLsofListenPID reads the pid from `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
func ParseLsofListenPID(listing string) (int, bool) {
	for _, line := range strings.Split(listing, "\n") {
		if strings.HasPrefix(line, "COMMAND") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil || pid <= 0 {
			continue
		}
		return pid, true
	}
	return 0, false
}

// ParseNetstatListenPID reads the listening pid of one port from `netstat -ano`.
// The local-address column is the listening endpoint, so a remote address that
// happens to share the digits is not mistaken for a holder.
func ParseNetstatListenPID(netstat string, port int) (int, bool) {
	suffix := ":" + strconv.Itoa(port)
	for _, line := range strings.Split(netstat, "\n") {
		if !strings.Contains(line, "LISTENING") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasSuffix(fields[1], suffix) {
			continue
		}
		pid, err := strconv.Atoi(fields[len(fields)-1])
		if err != nil || pid <= 0 {
			continue
		}
		return pid, true
	}
	return 0, false
}

// PortTerminationDependencies are the process operations the tree termination
// needs, exposed so the wait and the escalation can be tested without one.
type PortTerminationDependencies struct {
	Terminate func(pid int) error
	Force     func(pid int) error
	IsAlive   func(pid int) bool
	Wait      func(milliseconds int)
	// Budget and Now bound the wait. Both exist so the escalation can be tested
	// without spending the real two and a half seconds.
	Budget time.Duration
	Now    func() time.Time
}

// TerminatePortOccupant signals a leftover DSH tree and waits for it to actually
// disappear, escalating once when it does not.
func TerminatePortOccupant(pid int, deps PortTerminationDependencies) error {
	if deps.Terminate == nil {
		deps.Terminate = signalTerminatePort
	}
	if deps.Force == nil {
		deps.Force = forceTerminatePort
	}
	if deps.IsAlive == nil {
		deps.IsAlive = processIsAlive
	}
	if deps.Wait == nil {
		deps.Wait = func(milliseconds int) { time.Sleep(time.Duration(milliseconds) * time.Millisecond) }
	}
	if deps.Budget <= 0 {
		deps.Budget = 2500 * time.Millisecond
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if err := deps.Terminate(pid); err != nil {
		return nil
	}
	deadline := deps.Now().Add(deps.Budget)
	for deps.Now().Before(deadline) {
		deps.Wait(120)
		if !deps.IsAlive(pid) {
			return nil
		}
	}
	if err := deps.Force(pid); err != nil {
		return err
	}
	deps.Wait(120)
	return nil
}

// PortPreparation is the set of operations one port check needs. A zero value
// uses the production implementations, and the tests replace them so the
// decision can be driven without touching a real process.
type PortPreparation struct {
	Run        CommandRunner
	IsResidual func(commandLine string) bool
	Terminate  func(pid int) error
}

// PreparePortForLaunch checks one fixed port and decides whether to proceed.
// A leftover DSH Web process is adopted: the core stops the instance it
// implicitly owns before starting another. Any other holder is a refusal the
// caller renders rather than launches past.
func PreparePortForLaunch(port int, platform string, deps PortPreparation) PortDecision {
	if deps.Run == nil {
		deps.Run = SystemCommandRunner
	}
	if deps.IsResidual == nil {
		deps.IsResidual = IsResidualDshWebCommand
	}
	if deps.Terminate == nil {
		deps.Terminate = func(pid int) error { return TerminatePortOccupant(pid, PortTerminationDependencies{}) }
	}
	occupant, found := FindPortOccupant(port, platform, deps.Run)
	if !found {
		return PortDecision{Kind: PortFree}
	}
	if deps.IsResidual(occupant.CommandLine) {
		_ = deps.Terminate(occupant.PID)
		return PortDecision{Kind: PortCleared, PID: occupant.PID}
	}
	return PortDecision{Kind: PortForeign, Occupant: &occupant}
}

// ForeignPortFailure is the typed refusal a foreign holder surfaces as.
func ForeignPortFailure(port int, occupant PortOccupant) error {
	label := "pid " + strconv.Itoa(occupant.PID)
	if occupant.CommandLine != "" {
		command := occupant.CommandLine
		if len(command) > 80 {
			command = command[:80]
		}
		label += " (" + command + ")"
	}
	return fmt.Errorf(
		"%w: Port %d is already in use by another process: %s. Stop it and retry.",
		ErrPortInUse, port, label,
	)
}
