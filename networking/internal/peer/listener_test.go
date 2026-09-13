package peer

import (
	"context"
	"testing"
	"time"
)

// Both the endpoint that owns the session lifecycle and the http.Server that
// owns the listener close it, so a second Close must be a no-op. This panicked
// on a closed channel and took down a real revocation run.
func TestListenerCloseIsIdempotent(t *testing.T) {
	listener := NewListener(context.Background(), nil)
	if err := listener.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := listener.Accept(); err == nil {
		t.Fatal("a closed listener accepted")
	}
}

// A replaced session must not end the listener: Accept picks up the new mux
// instead of returning the error that would make http.Server tear down.
func TestListenerWaitsForReplacementInsteadOfFailing(t *testing.T) {
	listener := NewListener(context.Background(), nil)
	defer listener.Close()
	accepted := make(chan error, 1)
	go func() {
		_, err := listener.Accept()
		accepted <- err
	}()
	select {
	case err := <-accepted:
		t.Fatalf("Accept returned %v instead of waiting for a session", err)
	case <-time.After(100 * time.Millisecond):
	}
	// Closing is the only thing that ends the wait.
	listener.Close()
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("Accept ignored the listener closing")
	}
}
