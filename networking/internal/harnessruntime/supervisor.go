package harnessruntime

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Launch states, matching the view the shell already renders.
const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateStopped  = "stopped"
	StateFailed   = "failed"
)

// MaximumOutputBytes bounds the diagnostics counters: output past it still
// reaches the log file, but the counters report that they stopped counting.
const MaximumOutputBytes = 64 * 1024

// ShutdownTimeout is how long a stop waits for the child tree to exit before it
// escalates and, if needed, reports runtime.shutdown_timeout.
const ShutdownTimeout = 5 * time.Second

// Diagnostics are the bounded observable facts about one launch child.
type Diagnostics struct {
	StdoutBytes     int64  `json:"stdoutBytes"`
	StderrBytes     int64  `json:"stderrBytes"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	ExitCode        *int   `json:"exitCode,omitempty"`
	ExitSignal      string `json:"exitSignal,omitempty"`
}

// Failure is the typed reason one launch failed.
type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// LaunchView is one launch record as the shell reads it. The shell maps it onto
// its own renderer contract, so no renderer field is invented here.
type LaunchView struct {
	LaunchID      string      `json:"launchId"`
	SubjectID     string      `json:"subjectId"`
	State         string      `json:"state"`
	URL           string      `json:"url,omitempty"`
	Failure       *Failure    `json:"failure,omitempty"`
	PID           int         `json:"pid,omitempty"`
	Directory     string      `json:"directory"`
	Port          PortSetting `json:"port"`
	Diagnostics   Diagnostics `json:"diagnostics"`
	StartedAtUnix int64       `json:"startedAt,omitempty"`
}

// Spin-up input for one child. Identity is deliberately separate from the
// command so the supervision of an arbitrary child can be tested directly.
type Identity struct {
	LaunchID  string
	SubjectID string
	Port      PortSetting
	LogPath   string
}

// Supervisor owns every DSH Web child the core started. It is the process
// authority the shell used to hold, so a launch now survives neither a shell
// restart nor a second launcher: the core is the one writer of this state.
type Supervisor struct {
	platform    string
	runner      CommandRunner
	now         func() time.Time
	environment func() []string
	console     *Console

	mutex   sync.Mutex
	records map[string]*record
}

// NewSupervisor builds the production supervisor for this host.
func NewSupervisor() *Supervisor {
	return &Supervisor{
		platform:    runtime.GOOS,
		runner:      SystemCommandRunner,
		now:         time.Now,
		environment: os.Environ,
		console:     &Console{},
		records:     map[string]*record{},
	}
}

// Console is the bounded console feed every launch appends to.
func (supervisor *Supervisor) Console() *Console { return supervisor.console }

// Platform reports the host the supervisor makes its process decisions for.
func (supervisor *Supervisor) Platform() string { return supervisor.platform }

type record struct {
	identity Identity
	command  Command
	child    *exec.Cmd
	log      *os.File

	mutex         sync.Mutex
	observer      LineObserver
	state         string
	url           string
	failure       *Failure
	diagnostics   Diagnostics
	startedAtUnix int64
	exited        chan struct{}
}

// Start builds the exact command and starts one child. A subject that is already
// starting or running is refused rather than doubled.
func (supervisor *Supervisor) Start(request LaunchRequest) (LaunchView, error) {
	command, err := BuildCommand(request)
	if err != nil {
		return LaunchView{}, err
	}
	return supervisor.StartCommand(command, Identity{
		LaunchID:  request.LaunchID,
		SubjectID: request.SubjectID,
		Port:      request.Port,
		LogPath:   request.LogPath,
	})
}

// StartCommand starts one already-built command under a launch identity.
func (supervisor *Supervisor) StartCommand(command Command, identity Identity) (LaunchView, error) {
	if !opaqueIDPattern.MatchString(identity.LaunchID) || !opaqueIDPattern.MatchString(identity.SubjectID) {
		return LaunchView{}, fmt.Errorf("%w: Managed DSH launch input is invalid.", ErrInputInvalid)
	}
	if command.Directory == "" || command.Executable == "" {
		return LaunchView{}, fmt.Errorf("%w: Managed DSH launch input is invalid.", ErrInputInvalid)
	}
	supervisor.mutex.Lock()
	if existing, ok := supervisor.records[identity.SubjectID]; ok {
		if existing.currentState() == StateStarting || existing.currentState() == StateRunning {
			supervisor.mutex.Unlock()
			return LaunchView{}, fmt.Errorf("%w: DSH Web is already running.", ErrOperationInProgress)
		}
	}
	supervisor.mutex.Unlock()

	child := exec.Command(command.Executable, command.Arguments...)
	child.Dir = command.Directory
	child.Env = supervisor.environment()
	if command.Path != "" {
		child.Env = withPath(child.Env, command.Path)
	}
	child.SysProcAttr = processGroupAttributes()
	stdout, err := child.StdoutPipe()
	if err != nil {
		return LaunchView{}, fmt.Errorf("%w: DSH Web process could not be created.", ErrSpawnFailed)
	}
	stderr, err := child.StderrPipe()
	if err != nil {
		return LaunchView{}, fmt.Errorf("%w: DSH Web process could not be created.", ErrSpawnFailed)
	}
	active := &record{
		identity:      identity,
		command:       command,
		child:         child,
		state:         StateStarting,
		startedAtUnix: supervisor.now().UnixMilli(),
		exited:        make(chan struct{}),
	}
	// The log is opened before the child writes, and an unwritable log must not
	// take down the launch it was meant to explain.
	if logFile, openErr := openLaunchLog(identity.LogPath); openErr == nil {
		active.log = logFile
	}
	if err := child.Start(); err != nil {
		active.closeLog()
		return LaunchView{}, fmt.Errorf("%w: DSH Web process could not be created.", ErrSpawnFailed)
	}
	active.appendLauncherEvent(supervisor, "--- New DSH Web launch ---")
	active.appendLauncherEvent(supervisor, fmt.Sprintf("Started DSH Web child (pid=%d); waiting for its URL announcement.", child.Process.Pid))
	supervisor.mutex.Lock()
	supervisor.records[identity.SubjectID] = active
	supervisor.mutex.Unlock()

	go active.observe(supervisor, StreamStdout, stdout)
	go active.observe(supervisor, StreamStderr, stderr)
	go active.wait(supervisor)
	return active.view(), nil
}

// openLaunchLog starts a fresh log for each launch, so the file always describes
// the run the user is looking at.
func openLaunchLog(path string) (*os.File, error) {
	if path == "" {
		return nil, fmt.Errorf("%w: no launch log", ErrInputInvalid)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	_, _ = file.WriteString(fmt.Sprintf("[launcher] %s starting dsh web\n", time.Now().UTC().Format(time.RFC3339Nano)))
	return file, nil
}

func (active *record) closeLog() {
	if active.log != nil {
		_ = active.log.Close()
		active.log = nil
	}
}

func (active *record) writeLog(text string) {
	active.mutex.Lock()
	defer active.mutex.Unlock()
	if active.log != nil {
		_, _ = active.log.WriteString(text)
	}
}

// appendLauncherEvent records one lifecycle event generated by the core rather
// than by the child process, on both the log and the console feed.
func (active *record) appendLauncherEvent(supervisor *Supervisor, message string) {
	text := "[launcher] " + message + "\n"
	active.writeLog(text)
	supervisor.console.Append(StreamLaunch, text, supervisor.now())
}

// observe drains one child stream into the log and the live console, and reads
// the announced URL from complete lines only.
func (active *record) observe(supervisor *Supervisor, stream string, reader io.ReadCloser) {
	defer func() { _ = reader.Close() }()
	buffer := make([]byte, 4096)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			active.consume(supervisor, stream, string(buffer[:read]))
		}
		if err != nil {
			return
		}
	}
}

func (active *record) consume(supervisor *Supervisor, stream string, text string) {
	if text == "" {
		return
	}
	active.writeLog(text)
	supervisor.console.Append(ClassifyChildConsoleStream(stream, text), text, supervisor.now())
	active.mutex.Lock()
	countOutput(&active.diagnostics, stream, len(text))
	announced, found := active.observer.Observe(text)
	announcedNow := false
	if found && active.state == StateStarting {
		active.state = StateRunning
		active.url = announced
		announcedNow = true
	}
	active.mutex.Unlock()
	if announcedNow {
		active.appendLauncherEvent(supervisor, "DSH Web announced its loopback URL; runtime is ready.")
	}
}

// countOutput keeps the byte counters bounded independently of the log file.
func countOutput(diagnostics *Diagnostics, stream string, bytes int) {
	if stream == StreamStderr {
		diagnostics.StderrBytes += int64(bytes)
		if diagnostics.StderrBytes > MaximumOutputBytes {
			diagnostics.StderrTruncated = true
		}
		return
	}
	diagnostics.StdoutBytes += int64(bytes)
	if diagnostics.StdoutBytes > MaximumOutputBytes {
		diagnostics.StdoutTruncated = true
	}
}

func (active *record) wait(supervisor *Supervisor) {
	err := active.child.Wait()
	code := active.child.ProcessState.ExitCode()
	signal := exitSignal(active.child.ProcessState)
	active.mutex.Lock()
	if code >= 0 {
		active.diagnostics.ExitCode = &code
	}
	active.diagnostics.ExitSignal = signal
	active.mutex.Unlock()
	active.appendLauncherEvent(supervisor, fmt.Sprintf(
		"DSH Web process exited (code=%s signal=%s).", exitCodeLabel(code), signalLabel(signal),
	))
	active.closeLog()
	active.mutex.Lock()
	switch {
	case active.state == StateFailed:
	case code == 0 || signal == "terminated" || signal == "interrupt":
		active.state = StateStopped
	default:
		active.state = StateFailed
		message := "DSH Web exited unexpectedly."
		if err != nil {
			message = err.Error()
		}
		active.failure = &Failure{Code: "runtime.child_crashed", Message: message}
	}
	active.mutex.Unlock()
	close(active.exited)
}

func exitCodeLabel(code int) string {
	if code < 0 {
		return "none"
	}
	return fmt.Sprintf("%d", code)
}

func signalLabel(signal string) string {
	if signal == "" {
		return "none"
	}
	return signal
}

// Status returns one launch record, or false when the subject has never run.
func (supervisor *Supervisor) Status(subjectID string) (LaunchView, bool) {
	supervisor.mutex.Lock()
	active, ok := supervisor.records[subjectID]
	supervisor.mutex.Unlock()
	if !ok {
		return LaunchView{}, false
	}
	return active.view(), true
}

// markStopped records that a requested stop ended the child. Windows reports a
// forced tree kill as an exit code rather than a signal, so without this a
// deliberate stop would be rendered as a crash on that platform — which is what
// the shell's own stop avoided by setting its state after the tree was gone.
func (active *record) markStopped() {
	active.mutex.Lock()
	defer active.mutex.Unlock()
	active.state = StateStopped
	active.failure = nil
}

// Stop signals exactly the tree one launch created and waits for it to exit.
func (supervisor *Supervisor) Stop(subjectID string) (LaunchView, error) {
	supervisor.mutex.Lock()
	active, ok := supervisor.records[subjectID]
	supervisor.mutex.Unlock()
	if !ok {
		return LaunchView{}, fmt.Errorf("%w: DSH Web is not running.", ErrNotFound)
	}
	state := active.currentState()
	if state != StateStarting && state != StateRunning {
		return active.view(), nil
	}
	active.appendLauncherEvent(supervisor, "Stopping the managed DSH Web process tree.")
	if err := active.stopTree(); err != nil {
		// The process may already be gone; its exit is what decides the outcome.
		select {
		case <-active.exited:
			active.markStopped()
			return active.view(), nil
		default:
			return active.view(), fmt.Errorf("%w: Managed DSH process could not be stopped.", ErrChildUnavailable)
		}
	}
	select {
	case <-active.exited:
		active.markStopped()
		return active.view(), nil
	case <-time.After(ShutdownTimeout):
	}
	_ = terminateProcessTree(active.pid(), true)
	select {
	case <-active.exited:
		active.markStopped()
		return active.view(), nil
	case <-time.After(time.Second):
		return active.view(), fmt.Errorf("%w: Managed DSH process did not exit after SIGTERM.", ErrShutdownTimeout)
	}

}

// Shutdown stops every child this supervisor owns. It runs when the core is
// asked to exit, so no DSH Web child outlives the process that started it.
func (supervisor *Supervisor) Shutdown() {
	supervisor.mutex.Lock()
	subjects := make([]string, 0, len(supervisor.records))
	for subject := range supervisor.records {
		subjects = append(subjects, subject)
	}
	supervisor.mutex.Unlock()
	for _, subject := range subjects {
		_, _ = supervisor.Stop(subject)
	}
}

func (active *record) pid() int {
	if active.child == nil || active.child.Process == nil {
		return 0
	}
	return active.child.Process.Pid
}

func (active *record) stopTree() error {
	pid := active.pid()
	if pid <= 0 {
		return errors.New("the child has no process identifier")
	}
	return terminateProcessTree(pid, false)
}

func (active *record) currentState() string {
	active.mutex.Lock()
	defer active.mutex.Unlock()
	return active.state
}

func (active *record) view() LaunchView {
	active.mutex.Lock()
	defer active.mutex.Unlock()
	view := LaunchView{
		LaunchID:      active.identity.LaunchID,
		SubjectID:     active.identity.SubjectID,
		State:         active.state,
		URL:           active.url,
		Failure:       active.failure,
		PID:           active.pid(),
		Directory:     active.command.Directory,
		Port:          active.identity.Port,
		Diagnostics:   active.diagnostics,
		StartedAtUnix: active.startedAtUnix,
	}
	return view
}

// withPath replaces the PATH entry of one environment block, which is what a
// platform whose pnpm is a shell shim needs for its own subprocesses.
func withPath(environment []string, path string) []string {
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if len(entry) >= 5 && strings.EqualFold(entry[:5], "PATH=") {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "PATH="+path)
}
