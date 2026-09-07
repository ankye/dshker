package peer

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestMuxRejectsStaleScopeAndUnknownStream(t *testing.T) {
	for _, kind := range []string{"runtime", "attempt", "generation", "unknown", "duplicate-open", "inflation"} {
		t.Run(kind, func(t *testing.T) {
			ctx, left, right := streamPair(t)
			stream, err := left.Open()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := right.Accept(ctx); err != nil {
				t.Fatal(err)
			}
			frame := protocol.Frame{Version: 1, Type: "DATA", AttemptID: left.scope.AttemptID, Generation: left.scope.Generation, RuntimeGeneration: left.scope.RuntimeGeneration, StreamID: stream.ID(), Data: []byte("unauthorized")}
			switch kind {
			case "runtime":
				frame.RuntimeGeneration++
			case "attempt":
				frame.AttemptID = protocol.NewID()
			case "generation":
				frame.Generation++
			case "unknown":
				frame.StreamID += 10
			case "duplicate-open":
				frame.Type, frame.Data, frame.Credit = "OPEN", []byte{}, protocol.StreamWindowBytes
			case "inflation":
				frame.Type, frame.Data, frame.Credit = "WINDOW_UPDATE", []byte{}, 1
			}
			data, err := json.Marshal(frame)
			if err != nil {
				t.Fatal(err)
			}
			if err := left.link.Send(data); err != nil {
				t.Fatal(err)
			}
			select {
			case <-ctx.Done():
				t.Fatal("invalid frame did not terminate generation")
			case <-right.done:
			}
			right.mu.Lock()
			remaining := len(right.streams)
			failure := right.err
			right.mu.Unlock()
			if remaining != 0 || failure == nil {
				t.Fatal("invalid frame retained capabilities")
			}
		})
	}
}

func TestMuxConcurrentWriterCanCancelWhileCreditIsExhausted(t *testing.T) {
	ctx, left, right := streamPair(t)
	stream, err := left.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := right.Accept(ctx); err != nil {
		t.Fatal(err)
	}
	if n, err := stream.Write(ctx, make([]byte, protocol.StreamWindowBytes)); err != nil || n != protocol.StreamWindowBytes {
		t.Fatal(n, err)
	}
	// Both public writers lack credit. Cancelling the second must not depend
	// on the first writer's lifetime or the remote reader making progress.
	finished := make(chan error, 1)
	go func() {
		_, err := stream.Write(ctx, []byte("waiting"))
		finished <- err
	}()
	cancelCtx, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	if n, err := stream.Write(cancelCtx, []byte("cancelled")); n != 0 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("queued writer ignored cancellation", n, err)
	}
	left.Close()
	if err := <-finished; err == nil {
		t.Fatal("shutdown failed to interrupt outstanding write")
	}
}
