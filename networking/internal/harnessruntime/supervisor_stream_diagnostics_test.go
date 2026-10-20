package harnessruntime

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type terminatingStream struct {
	text   string
	reason error
	closed bool
}

func (stream *terminatingStream) Read(buffer []byte) (int, error) {
	return copy(buffer, stream.text), stream.reason
}

func (stream *terminatingStream) Close() error { stream.closed = true; return nil }

func TestSupervisorStreamTerminationRetainsBoundedReadCause(t *testing.T) {
	for _, test := range []struct {
		name, stream, reason string
		err                  error
	}{
		{"stdout EOF", StreamStdout, "eof", io.EOF},
		{"stderr EOF", StreamStderr, "eof", io.EOF},
		{"closed pipe", StreamStdout, "closed", fmt.Errorf("wrapped: %w", os.ErrClosed)},
		{"closed in-memory pipe", StreamStderr, "closed", io.ErrClosedPipe},
		{"unexpected read failure", StreamStderr, "read_failed", errors.New("private token=do-not-log file=/secret/path")},
	} {
		t.Run(test.name, func(t *testing.T) {
			supervisor := NewSupervisor()
			active := &record{identity: Identity{LaunchID: "launch_test"}, state: StateStarting, exited: make(chan struct{})}
			stream := &terminatingStream{reason: test.err}
			active.observe(supervisor, test.stream, stream)
			entries, _ := supervisor.Console().After(0)
			if len(entries) != 1 || entries[0].Stream != StreamLaunch {
				t.Fatalf("missing fixed lifecycle receipt: %+v", entries)
			}
			want := "[launcher] DSH Web stream ended (stream=" + test.stream + " reason=" + test.reason + " launch=launch_test pid=0 childWait=pending).\n"
			if entries[0].Text != want {
				t.Fatalf("stream receipt = %q, want %q", entries[0].Text, want)
			}
			if !stream.closed || active.state != StateStarting || active.url != "" || active.failure != nil || active.diagnostics.StdoutBytes != 0 || active.diagnostics.StderrBytes != 0 {
				t.Fatal("diagnostic changed child authority or manufactured output", active.view())
			}
		})
	}
}

func TestSupervisorStreamTerminationConsumesBytesBeforeEOF(t *testing.T) {
	supervisor := NewSupervisor()
	active := &record{identity: Identity{LaunchID: "launch_test"}, state: StateStarting, exited: make(chan struct{})}
	close(active.exited)
	text := "dsh web: http://127.0.0.1:3088/?token=test-only\n"
	stream := &terminatingStream{text: text, reason: io.EOF}
	active.observe(supervisor, StreamStdout, stream)
	if active.state != StateRunning || active.url != "http://127.0.0.1:3088/?token=test-only" || active.diagnostics.StdoutBytes != int64(len(text)) {
		t.Fatal("final chunk was lost at EOF", active.view())
	}
	entries, _ := supervisor.Console().After(0)
	last := entries[len(entries)-1].Text
	if !strings.Contains(last, "reason=eof launch=launch_test pid=0 childWait=completed") || strings.Contains(last, "token=") {
		t.Fatal("receipt lost exact Wait completion or copied child content", last)
	}
}

func TestSupervisorStreamTerminationAndLogCloseHaveOneFileOwner(t *testing.T) {
	supervisor := NewSupervisor()
	file, err := os.Create(filepath.Join(t.TempDir(), "launch.log"))
	if err != nil {
		t.Fatal(err)
	}
	active := &record{identity: Identity{LaunchID: "launch_test"}, log: file, exited: make(chan struct{})}
	defer active.closeLog()
	start := make(chan struct{})
	var workers sync.WaitGroup
	for index := 0; index < 32; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			active.observe(supervisor, StreamStdout, &terminatingStream{reason: io.EOF})
		}()
	}
	workers.Add(1)
	go func() { defer workers.Done(); <-start; active.closeLog() }()
	close(start)
	workers.Wait()
	entries, _ := supervisor.Console().After(0)
	if len(entries) != 32 {
		t.Fatalf("EOF receipts lost while the exact launch log closed: %d", len(entries))
	}
}
