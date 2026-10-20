package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type processStopReceipt struct {
	PID             int    `json:"pid"`
	Abrupt          bool   `json:"abrupt"`
	SignalRequested bool   `json:"signalRequested"`
	Signal          string `json:"signal"`
	StdinClose      string `json:"stdinClose"`
	KillRequested   bool   `json:"killRequested"`
	Kill            string `json:"kill"`
	TimedOut        bool   `json:"timedOut"`
	WaitCompleted   bool   `json:"waitCompleted"`
	Wait            string `json:"wait"`
	ProcessExited   bool   `json:"processExited"`
	ExitCode        int    `json:"exitCode"`
	CopyJoined      bool   `json:"copyJoined"`
}

func (receipt *processStopReceipt) complete(owner *process) {
	// Only the unique cmd.Wait owner publishes done. Wait joins exec's copying
	// goroutines too; a pre-Wait timeout cannot safely read Cmd.ProcessState.
	receipt.WaitCompleted = true
	receipt.Wait = processStopError(owner.waitErr)
	receipt.ProcessExited = owner.cmd.ProcessState != nil
	if receipt.ProcessExited {
		receipt.ExitCode = owner.cmd.ProcessState.ExitCode()
	}
	receipt.CopyJoined = true
}

func (receipt processStopReceipt) json() string { return stopDiagnosticJSON(receipt) }

func processStopError(err error) string {
	var exit *exec.ExitError
	var errno syscall.Errno
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, os.ErrProcessDone):
		return "process_done"
	case errors.As(err, &exit):
		return "exit_error"
	case errors.Is(err, exec.ErrWaitDelay):
		return "copy_wait_delay"
	case errors.As(err, &errno):
		return "errno_" + strconv.FormatUint(uint64(errno), 10)
	default:
		return "operation_failed"
	}
}

func stopDiagnosticJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic("process stop diagnostic encoding failed")
	}
	return string(encoded)
}

type serverStopRecord struct {
	PID       int    `json:"pid"`
	Phase     string `json:"phase"`
	Event     string `json:"event"`
	Code      string `json:"code"`
	ElapsedMS int64  `json:"elapsedMs"`
	Dropped   int    `json:"dropped"`
}

type serverStopSnapshot struct {
	Records    []serverStopRecord `json:"records"`
	Dropped    int                `json:"dropped"`
	Malformed  int                `json:"malformed"`
	Overlong   int                `json:"overlong"`
	Unfinished int                `json:"unfinished"`
	IOState    string             `json:"ioState"`
}

// This test-only writer accepts a bounded fixed-field lifecycle receipt, never
// generic stderr. It runs in exec's copy worker and is snapshotted after Wait.
type serverStopDiagnostics struct {
	mu       sync.Mutex
	line     []byte
	overlong bool
	view     serverStopSnapshot
}

func (capture *serverStopDiagnostics) Write(data []byte) (int, error) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	for _, value := range data {
		if value == '\n' {
			if capture.overlong {
				capture.view.Overlong++
			} else {
				capture.record(string(capture.line))
			}
			capture.line = capture.line[:0]
			capture.overlong = false
		} else if !capture.overlong {
			if len(capture.line) == 1024 {
				capture.overlong = true
			} else {
				capture.line = append(capture.line, value)
			}
		}
	}
	return len(data), nil
}

func (capture *serverStopDiagnostics) record(line string) {
	_, body, found := strings.Cut(line, "[p2p] shutdown ")
	if !found {
		return
	}
	var record serverStopRecord
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&record) != nil || decoder.Decode(new(any)) != io.EOF || !stopPhase(record.Phase) || !stopEvent(record.Event) || !stopCode(record.Code) || record.PID < 1 || record.ElapsedMS < 0 || record.ElapsedMS > 86_400_000 || record.Dropped < 0 {
		capture.view.Malformed++
		return
	}
	if len(capture.view.Records) == 160 {
		capture.view.Dropped++
		return
	}
	capture.view.Records = append(capture.view.Records, record)
}

func stopPhase(value string) bool {
	switch value {
	case "trigger", "signal_received", "http_drain", "http_force_close", "worker_join", "https_worker", "udp_worker", "udp_cancel", "raw_tcp_close", "tcp_listener_close", "udp_close", "store_close", "v1_ws_close", "v1_ws_close_now", "v2_ws_close", "v2_ws_close_now", "signal_handler", "control_handler", "v1_displaced_worker", "v2_displaced_worker", "v1_writer_worker", "v2_writer_worker", "v2_health_worker", "run", "receipt", "diagnostic_io", "connection_quiesce", "admitted_handlers_join", "signal_workers_join", "listener_workers_join":
		return true
	}
	return false
}

func stopEvent(value string) bool {
	switch value {
	case "observed", "start", "done", "returned", "requested", "not_requested", "not_observed", "exited", "snapshot", "drained":
		return true
	}
	return false
}

func stopCode(value string) bool {
	switch value {
	case "none", "context_cancelled", "listener_result", "deadline_exceeded", "net_closed", "http_server_closed", "operation_failed":
		return true
	}
	return false
}

func (capture *serverStopDiagnostics) snapshot() serverStopSnapshot {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	view := capture.view
	view.IOState = "unknown"
	view.Records = append([]serverStopRecord{}, view.Records...)
	for _, record := range view.Records {
		if record.Phase == "diagnostic_io" && record.Event == "drained" {
			view.IOState = "drained"
			if record.Dropped != 0 || record.Code != "none" {
				view.IOState = "partial"
			}
		}
	}
	if len(capture.line) != 0 || capture.overlong {
		view.Unfinished++
	}
	return view
}

func TestProcessStopDiagnosticsRejectsArbitraryFieldsAndBoundsRetention(t *testing.T) {
	capture := &serverStopDiagnostics{}
	valid := `2026/10/20 12:00:00 [p2p] shutdown {"pid":1,"phase":"http_drain","event":"start","code":"none","elapsedMs":0,"dropped":0}` + "\n"
	for _, value := range []byte(valid) {
		_, _ = capture.Write([]byte{value})
	}
	_, _ = capture.Write([]byte("unrelated password=must-not-survive\n"))
	_, _ = capture.Write([]byte(strings.Replace(valid, `"phase":"http_drain"`, `"phase":"private-key-must-not-survive"`, 1)))
	_, _ = capture.Write([]byte(strings.Replace(valid, `"pid":1`, `"pid":1,"token":"must-not-survive"`, 1)))
	for range 200 {
		_, _ = capture.Write([]byte(valid))
	}
	view := capture.snapshot()
	if len(view.Records) != 160 || view.Malformed != 2 || view.Dropped != 41 || strings.Contains(stopDiagnosticJSON(view), "must-not-survive") {
		t.Fatal("lifecycle receipt accepted arbitrary output or lost bounds", view)
	}
}

func TestProcessStopReadbackDoesNotFormatArbitraryErrorText(t *testing.T) {
	for _, sample := range []struct {
		err  error
		want string
	}{{nil, "none"}, {os.ErrProcessDone, "process_done"}, {exec.ErrWaitDelay, "copy_wait_delay"}, {syscall.Errno(13), "errno_13"}, {errors.New("password-token-private-key-must-not-survive"), "operation_failed"}} {
		if got := processStopError(sample.err); got != sample.want {
			t.Fatalf("wrong safe process error class: got %s want %s", got, sample.want)
		}
	}
}

type processStopReadyWriter struct {
	mu    sync.Mutex
	once  sync.Once
	text  string
	ready chan struct{}
}

func (writer *processStopReadyWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.text) < 1024 {
		writer.text += string(data)
		if strings.Contains(writer.text, "PROCESS_STOP_READY\n") {
			writer.once.Do(func() { close(writer.ready) })
		}
	}
	return len(data), nil
}

func TestProcessStopDiagnosticHelper(t *testing.T) {
	switch os.Getenv("DSHKER_TEST_PROCESS_STOP_DIAGNOSTIC_ROLE") {
	case "":
		return
	case "child":
		signal.Ignore(os.Interrupt)
		fmt.Println("PROCESS_STOP_READY")
		<-time.After(time.Minute)
	case "supervisor":
		binary, err := os.Executable()
		must(t, err)
		command := exec.Command(binary, "-test.run=^TestProcessStopDiagnosticHelper$", "-test.timeout=12s")
		command.Env = append(os.Environ(), "DSHKER_TEST_PROCESS_STOP_DIAGNOSTIC_ROLE=child")
		ready := &processStopReadyWriter{ready: make(chan struct{})}
		command.Stdout = ready
		command.Stderr = os.Stderr
		owner := launch(t, command)
		select {
		case <-ready.ready:
		case <-time.After(2 * time.Second):
			t.Fatal("ignored-signal helper did not reach its explicit ready barrier")
		}
		owner.stop(t, false)
		fmt.Println("PROCESS_STOP_CONTINUED")
	default:
		t.Fatal("unknown process stop diagnostic helper role")
	}
}
