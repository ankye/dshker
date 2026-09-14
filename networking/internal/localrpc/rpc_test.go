package localrpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func rpcPair(t *testing.T, handler Handler) (*Peer, *Peer) {
	t.Helper()
	a, b := net.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	left := New(ctx, a, handler)
	right := New(ctx, b, handler)
	t.Cleanup(func() { cancel(); left.Close(); right.Close() })
	return left, right
}

func TestConcurrentBidirectionalCalls(t *testing.T) {
	echo := func(_ context.Context, method string, data json.RawMessage) (any, error) {
		if method != "echo" {
			return nil, errors.New("p2p.invalid_operation")
		}
		return data, nil
	}
	left, right := rpcPair(t, echo)
	// A peer admits sixteen calls in flight and refuses beyond that with
	// p2p.helper_busy, which TestStressHelperBusySaturation pins. Sixteen workers
	// here is deliberately at that bound, so a refusal is the documented
	// backpressure rather than a failure: it is retried, and what this test
	// proves is that every call still round-trips with its own id and payload.
	call := func(client *Peer, input struct{ Worker, Sequence int }) (json.RawMessage, error) {
		for attempt := 0; ; attempt++ {
			result, err := client.Call(client.ctx, "echo", input)
			if err == nil || !strings.Contains(err.Error(), "p2p.helper_busy") {
				return result, err
			}
			if attempt == 200 {
				return nil, err
			}
			time.Sleep(time.Millisecond)
		}
	}
	var workers sync.WaitGroup
	for _, client := range []*Peer{left, right} {
		for worker := 0; worker < 8; worker++ {
			workers.Add(1)
			go func(client *Peer, worker int) {
				defer workers.Done()
				for sequence := 0; sequence < 50; sequence++ {
					input := struct{ Worker, Sequence int }{worker, sequence}
					result, err := call(client, input)
					if err != nil {
						t.Errorf("call %d/%d: %v", worker, sequence, err)
						return
					}
					var received struct{ Worker, Sequence int }
					if json.Unmarshal(result, &received) != nil || received != input {
						t.Errorf("response mismatch: %s", result)
						return
					}
				}
			}(client, worker)
		}
	}
	workers.Wait()
}

func TestErrorRedactionAndCancelledAdmission(t *testing.T) {
	left, _ := rpcPair(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("password=private-credential")
	})
	_, err := left.Call(left.ctx, "fail", struct{}{})
	if err == nil || err.Error() != "p2p.operation_failed" {
		t.Fatalf("unredacted result: %v", err)
	}
	// A refusal that carries a diagnostic keeps its code: the detail is dropped
	// rather than the whole classification. internal/secret wraps its sentinels
	// this way, and collapsing them hid which store failed.
	wrapped, _ := rpcPair(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, fmt.Errorf("%w: value too large", errors.New("p2p.secret_write_failed"))
	})
	_, err = wrapped.Call(wrapped.ctx, "fail", struct{}{})
	if err == nil || err.Error() != "p2p.secret_write_failed" {
		t.Fatalf("wrapped refusal lost its code: %v", err)
	}
	ctx, cancel := context.WithCancel(left.ctx)
	cancel()
	_, err = left.Call(ctx, "cancelled", struct{}{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled call: %v", err)
	}
	left.mu.Lock()
	defer left.mu.Unlock()
	if left.next != 1 || len(left.pending) != 0 {
		t.Fatal("cancelled call was admitted or pending call leaked")
	}
}

func TestMalformedFramesCloseChannel(t *testing.T) {
	for _, frame := range []string{
		`{"version":1,"id":1,"method":"","payload":{},"error":"token=secret"}`,
		`{"version":1,"id":1,"method":"echo","payload":{},"error":"","extra":true}`,
		`{"version":1,"id":1,"id":2,"method":"echo","payload":{},"error":""}`,
		`{"version":1,"id":0,"method":"echo","payload":{},"error":""}`,
	} {
		t.Run(frame, func(t *testing.T) {
			a, b := net.Pipe()
			defer b.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			client := New(ctx, a, func(context.Context, string, json.RawMessage) (any, error) {
				t.Error("invalid frame reached handler")
				return struct{}{}, nil
			})
			defer client.Close()
			if _, err := b.Write([]byte(frame + "\n")); err != nil {
				t.Fatal(err)
			}
			select {
			case <-client.Done():
			case <-ctx.Done():
				t.Fatal("invalid frame did not close channel")
			}
		})
	}
}
