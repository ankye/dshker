//go:build live

package integration

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRecoveryWSSealRejectsEndedOrUnhealthyCarrier(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*recoveryWS)
	}{
		{"reader-done", func(stream *recoveryWS) { close(stream.done) }},
		{"reader-error", func(stream *recoveryWS) { stream.err = errors.New("test.earlier_reader_error") }},
		{"application-error", func(stream *recoveryWS) { stream.appError = true }},
		{"expected-loss", func(stream *recoveryWS) { stream.expectLoss = true }},
		{"already-local-close", func(stream *recoveryWS) { stream.localClose = true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			stream := &recoveryWS{done: make(chan struct{})}
			test.edit(stream)
			if err := stream.SealCloseJoin(); err == nil {
				t.Fatal("strict seal admitted an already ended or unhealthy carrier")
			}
			if stream.boundary.Load() != nil {
				t.Fatal("rejected seal installed an intentional-close boundary")
			}
		})
	}
}

func TestRecoveryWSSealPreservesFailureCapturedBeforeReaderMutex(t *testing.T) {
	stream := &recoveryWS{done: make(chan struct{}), log: t.Logf}
	want := errors.New("test.original_natural_reader_failure")
	stream.mu.Lock()
	// Exact reader interleaving: Read returned a failure and captured its atomic
	// boundary, while publishing err is prevented from acquiring mu.
	first := stream.captureFailure(want, false)
	published := make(chan struct{})
	go func() {
		stream.publishFailure(first)
		close(published)
	}()
	sealed := make(chan error, 1)
	go func() { sealed <- stream.SealCloseJoin() }()
	var sealErr error
	select {
	case sealErr = <-sealed:
	case <-time.After(5 * time.Second):
		stream.mu.Unlock()
		<-published
		<-sealed
		t.Fatal("seal waited for the reader mutex instead of refusing its captured failure")
	}
	if !errors.Is(sealErr, want) {
		stream.mu.Unlock()
		<-published
		t.Fatalf("seal washed a captured natural failure into local close: %v", sealErr)
	}
	if first.localClose || stream.localClose {
		stream.mu.Unlock()
		<-published
		t.Fatal("early reader failure was relabeled as intentional local close")
	}
	stream.mu.Unlock()
	<-published
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if !errors.Is(stream.err, want) || stream.boundary.Load() != first {
		t.Fatal("reader publication did not retain the exact first captured failure")
	}
}

func TestRecoveryWSSealPreservesFirstApplicationFailure(t *testing.T) {
	stream := &recoveryWS{done: make(chan struct{}), log: t.Logf}
	want := errors.New("test.original_application_failure")
	first := stream.captureFailure(want, true)
	stream.publishFailure(first)
	// A later cancellation/cleanup symptom must not replace the owning failure.
	stream.publishFailure(stream.captureFailure(context.Canceled, false))
	if err := stream.SealCloseJoin(); !errors.Is(err, want) {
		t.Fatalf("seal discarded the first application failure: %v", err)
	}
	if !stream.appError || !errors.Is(stream.err, want) || first.localClose {
		t.Fatal("later reader termination overwrote the first application failure")
	}
}

func TestRecoveryWSSealCannotOutrunEarlierErrorCapture(t *testing.T) {
	stream := &recoveryWS{done: make(chan struct{}), log: t.Logf}
	want := errors.New("test.reader_error_captured_before_seal_claim")
	// The reader has captured its error and timestamp, but is descheduled
	// immediately before publishing the atomic boundary. No sleeping decides
	// this order: seal deliberately wins CAS before recordFailure resumes.
	failure := &recoveryWSBoundary{err: want, capturedAt: time.Now()}
	if err := stream.sealClose(); err != nil {
		t.Fatal(err)
	}
	sealed := stream.boundary.Load()
	if !failure.capturedAt.Before(sealed.capturedAt) || !sealed.sealed {
		t.Fatal("test did not establish error capture before the later seal claim")
	}
	retained := stream.recordFailure(failure)
	stream.publishFailure(retained)
	if retained != failure || retained.localClose || stream.boundary.Load() != failure {
		t.Fatal("later seal CAS relabeled an earlier captured reader failure")
	}
	if err := stream.SealCloseJoin(); !errors.Is(err, want) {
		t.Fatalf("seal acknowledgement discarded a prior error after losing capture order: %v", err)
	}
}

func TestRecoveryWSSealCloseJoinsHealthyRealReader(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := recoverySealTestConnection(t, ctx)
	stream := recoveryReadWS(t, connection, new(atomic.Int64))
	if err := stream.SealCloseJoin(); err != nil {
		t.Fatalf("healthy current carrier could not seal, close and join: %v", err)
	}
	select {
	case <-stream.done:
	default:
		t.Fatal("seal acknowledgement preceded the actual reader join")
	}
	first := stream.boundary.Load()
	if first == nil || !first.sealed || !first.localClose || first.err != nil || stream.expectLoss {
		t.Fatal("healthy seal did not retain a strict identity-bearing local-close boundary")
	}
	if err := stream.SealCloseJoin(); err == nil {
		t.Fatal("second seal accepted an already sealed carrier")
	}
}

func TestRecoveryWSSealJoinReturnsEarlierDelayedFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection := recoverySealTestConnection(t, ctx)
	readerCtx, cancelReader := context.WithCancel(ctx)
	defer cancelReader()
	stream := &recoveryWS{connection: connection, id: "strict-seal-reader", done: make(chan struct{}), inbox: make(chan recoveryFollowFrame, 1), log: t.Logf}
	want := errors.New("test.earlier_reader_error_published_during_close")
	failure := &recoveryWSBoundary{err: want, capturedAt: time.Now()}
	// Publish the already-captured error only when SealCloseJoin has sealed and
	// entered local close. The actual reader then exits on cancellation, and its
	// later symptom must not erase the earlier error returned after joining.
	stream.cancel = func() {
		stream.publishFailure(stream.recordFailure(failure))
		cancelReader()
	}
	go stream.read(readerCtx)
	if err := stream.SealCloseJoin(); !errors.Is(err, want) {
		t.Fatalf("join acknowledgement hid an earlier delayed reader failure: %v", err)
	}
	select {
	case <-stream.done:
	default:
		t.Fatal("failed seal returned before joining its actual reader")
	}
	if stream.boundary.Load() != failure || failure.localClose || !errors.Is(stream.err, want) {
		t.Fatal("close/join overwrote the exact earlier captured reader failure")
	}
}

func recoverySealTestConnection(t *testing.T, ctx context.Context) *websocket.Conn {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		accepted <- connection
		<-release
		connection.CloseNow()
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.CloseNow() })
	select {
	case <-accepted:
	case <-ctx.Done():
		t.Fatal("local real WS reader was not accepted")
	}
	return connection
}
