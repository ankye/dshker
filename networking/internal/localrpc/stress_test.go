package localrpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// TestStressConcurrentCalls runs thousands of concurrent echo calls over one
// private channel, staying inside the 16-in-flight budget per direction so a
// p2p.helper_busy response is never legitimate: every call must round-trip
// byte-for-byte.
func TestStressConcurrentCalls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	channel := admitCore(t, ctx)
	const workers = 8
	const perWorker = 1000
	var wg sync.WaitGroup
	failures := make(chan error, workers)
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				payload := fmt.Sprintf("{\"worker\":%d,\"i\":%d}", worker, i)
				output, err := channel.parent.Call(ctx, "core.echo", json.RawMessage(payload))
				if err != nil {
					failures <- fmt.Errorf("worker %d call %d: %w", worker, i, err)
					return
				}
				if !bytes.Equal(output, json.RawMessage(payload)) {
					failures <- fmt.Errorf("worker %d call %d: %s != %s", worker, i, output, payload)
					return
				}
			}
		}(worker)
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}

// admitRawParent brings up the private channel with a custom core handler and
// hands back the raw parent connection, so the test can fire more frames than
// the 16-slot budget without Peer.Call pacing the requests.
func admitRawParent(t *testing.T, ctx context.Context, handler Handler) net.Conn {
	t.Helper()
	endpoint := testEndpoint(t)
	ready, output := io.Pipe()
	t.Cleanup(func() { ready.Close(); output.Close() })
	result := startFakeCore(ctx, bootstrapRecord(endpoint, conformanceSecret), output)
	line, err := bufio.NewReader(ready).ReadString('\n')
	if err != nil || line != readinessLine {
		t.Fatalf("bootstrap readiness: %q %v", line, err)
	}
	conn, err := dialPrivate(endpoint)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	if err = authenticate(conn, conformanceSecret); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	coreChannel := <-result
	if coreChannel.err != nil {
		t.Fatalf("core bootstrap: %v", coreChannel.err)
	}
	t.Cleanup(func() { coreChannel.conn.Close() })
	corePeer := New(ctx, coreChannel.conn, handler)
	t.Cleanup(corePeer.Close)
	return conn
}

// TestStressHelperBusySaturation fires a 32-deep burst of requests at a slow
// handler: the read loop admits sixteen concurrent handlers and answers the
// rest with p2p.helper_busy, exactly per the contract, without reordering or
// dropping any response id.
func TestStressHelperBusySaturation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	slowHandler := func(_ context.Context, _ string, _ json.RawMessage) (any, error) {
		time.Sleep(40 * time.Millisecond)
		return json.RawMessage("{\"ok\":true}"), nil
	}
	conn := admitRawParent(t, ctx, slowHandler)
	conn.SetDeadline(time.Now().Add(20 * time.Second))
	reader := bufio.NewReader(conn)
	const burst = 32
	seen := make(map[uint64]string)
	for i := 0; i < burst; i++ {
		id := uint64(i + 1)
		data, err := json.Marshal(Frame{Version: 1, ID: id, Method: "core.echo", Payload: json.RawMessage("{\"n\":1}")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Write(append(data, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	busy, okay := 0, 0
	for i := 0; i < burst; i++ {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatalf("read response %d: %v", i, err)
		}
		var frame Frame
		if err = protocol.Decode(line, &frame); err != nil {
			t.Fatalf("decode response %d: %v (%s)", i, err, line)
		}
		if frame.Method != "" || frame.ID == 0 {
			t.Fatalf("unexpected response frame %s", line)
		}
		if previous, duplicate := seen[frame.ID]; duplicate {
			t.Fatalf("duplicate response for id %d (%s and %s)", frame.ID, previous, frame.Error)
		}
		seen[frame.ID] = frame.Error
		switch frame.Error {
		case "":
			okay++
		case "p2p.helper_busy":
			busy++
		default:
			t.Fatalf("unexpected error for id %d: %s", frame.ID, frame.Error)
		}
	}
	if len(seen) != burst {
		t.Fatalf("saw %d of %d response ids", len(seen), burst)
	}
	if okay == 0 {
		t.Fatal("no request was served")
	}
	if busy == 0 {
		t.Fatal("expected p2p.helper_busy under a 32-deep burst")
	}
}
