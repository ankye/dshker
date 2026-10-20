package peer

import (
	"errors"
	"sync"
	"testing"
)

func TestMuxErrReadsFirstFailureWithoutTerminating(t *testing.T) {
	mux := &Mux{streams: make(map[uint32]*Stream), changed: make(chan struct{}), done: make(chan struct{})}
	if mux.Err() != nil {
		t.Fatal("an active mux reported an invented failure")
	}
	select {
	case <-mux.Done():
		t.Fatal("reading mux diagnostics terminated an active mux")
	default:
	}
	first := errors.New("p2p.frame_scope_mismatch")
	mux.mu.Lock()
	mux.fail(first)
	mux.mu.Unlock()
	var readers sync.WaitGroup
	for range 20 {
		readers.Go(func() {
			if mux.Err() != first {
				t.Error("read-only mux diagnostics lost the original protocol failure")
			}
		})
	}
	readers.Wait()
	if err := mux.Close(); err != nil {
		t.Fatal(err)
	}
	if mux.Err() != first {
		t.Fatal("mux cleanup replaced the first protocol failure")
	}
}
