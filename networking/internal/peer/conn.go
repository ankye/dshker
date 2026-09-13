package peer

import (
	"context"
	"net"
	"os"
	"sync"
	"time"
)

// Conn adapts an authenticated bounded stream for net/http. Deadline changes
// interrupt current waits without resetting the underlying stream.
type Conn struct {
	stream                      *Stream
	ctx                         context.Context
	cancel                      context.CancelFunc
	mu                          sync.Mutex
	readMu, writeMu             sync.Mutex
	readDeadline, writeDeadline time.Time
	readCancel, writeCancel     context.CancelFunc
}

func NewConn(ctx context.Context, stream *Stream) *Conn {
	child, cancel := context.WithCancel(ctx)
	return &Conn{stream: stream, ctx: child, cancel: cancel}
}

func (conn *Conn) operation(read bool, data []byte) (int, error) {
	// net.Conn permits concurrent callers; each direction has only one active
	// deadline cancellation slot, while reads and writes remain independent.
	gate := &conn.writeMu
	if read {
		gate = &conn.readMu
	}
	gate.Lock()
	defer gate.Unlock()
	for {
		conn.mu.Lock()
		deadline := conn.writeDeadline
		if read {
			deadline = conn.readDeadline
		}
		ctx, cancel := context.WithCancel(conn.ctx)
		if !deadline.IsZero() {
			cancel()
			ctx, cancel = context.WithDeadline(conn.ctx, deadline)
		}
		if read {
			conn.readCancel = cancel
		} else {
			conn.writeCancel = cancel
		}
		conn.mu.Unlock()
		var n int
		var err error
		if read {
			n, err = conn.stream.Read(ctx, data)
		} else {
			n, err = conn.stream.Write(ctx, data)
		}
		cancel()
		conn.mu.Lock()
		if read {
			conn.readCancel = nil
		} else {
			conn.writeCancel = nil
		}
		conn.mu.Unlock()
		if err == context.DeadlineExceeded {
			return n, os.ErrDeadlineExceeded
		}
		if err != context.Canceled || conn.ctx.Err() != nil || n != 0 {
			return n, err
		}
		// Only a deadline update cancelled this wait; re-evaluate its new value.
	}
}

func (conn *Conn) Read(data []byte) (int, error)  { return conn.operation(true, data) }
func (conn *Conn) Write(data []byte) (int, error) { return conn.operation(false, data) }
func (conn *Conn) Close() error                   { conn.cancel(); return conn.stream.Close() }
func (conn *Conn) CloseWrite() error              { return conn.stream.CloseWrite() }
func (conn *Conn) LocalAddr() net.Addr            { return streamAddr("local") }
func (conn *Conn) RemoteAddr() net.Addr           { return streamAddr("peer") }
func (conn *Conn) SetDeadline(value time.Time) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	conn.readDeadline, conn.writeDeadline = value, value
	if conn.readCancel != nil {
		conn.readCancel()
	}
	if conn.writeCancel != nil {
		conn.writeCancel()
	}
	return nil
}
func (conn *Conn) SetReadDeadline(value time.Time) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	conn.readDeadline = value
	if conn.readCancel != nil {
		conn.readCancel()
	}
	return nil
}
func (conn *Conn) SetWriteDeadline(value time.Time) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	conn.writeDeadline = value
	if conn.writeCancel != nil {
		conn.writeCancel()
	}
	return nil
}

type streamAddr string

func (addr streamAddr) Network() string { return "dshker-peer" }
func (addr streamAddr) String() string  { return string(addr) }

// Listener exposes only streams accepted on one authenticated mux. It never
// listens on an OS network interface or accepts an arbitrary destination.
//
// The mux inside it is replaceable: a session drop must not surface as a
// listener-ending error, because net/http.Server.Serve treats a non-temporary
// Accept error as fatal and tears down the whole server, forcing every
// caller to know how to restart one. Accept instead waits for the next mux
// while the direct path is being rebuilt, exactly like OpenBrowserEndpoint
// waits for the next session before dialing again.
type Listener struct {
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	mux      *Mux
	closed   bool
	replaced chan struct{}
}

func NewListener(ctx context.Context, mux *Mux) *Listener {
	child, cancel := context.WithCancel(ctx)
	return &Listener{ctx: child, cancel: cancel, mux: mux, replaced: make(chan struct{})}
}

// Replace attaches a rebuilt session's mux. Any Accept call currently waiting
// for one picks it up immediately.
func (listener *Listener) Replace(mux *Mux) {
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		return
	}
	listener.mux = mux
	signal := listener.replaced
	listener.replaced = make(chan struct{})
	listener.mu.Unlock()
	close(signal)
}

// Detach drops the current session without ending the listener, so Accept
// waits for the next Replace instead of failing the whole server.
func (listener *Listener) Detach() {
	listener.mu.Lock()
	listener.mux = nil
	listener.mu.Unlock()
}

func (listener *Listener) Accept() (net.Conn, error) {
	for {
		listener.mu.Lock()
		if listener.closed {
			listener.mu.Unlock()
			return nil, net.ErrClosed
		}
		mux := listener.mux
		waiting := listener.replaced
		listener.mu.Unlock()
		if mux == nil {
			// No session right now: wait for Replace or for the listener itself to
			// end, rather than returning the fatal error that would kill Serve.
			select {
			case <-waiting:
				continue
			case <-listener.ctx.Done():
				return nil, net.ErrClosed
			}
		}
		stream, err := mux.Accept(listener.ctx)
		if err != nil {
			if listener.ctx.Err() != nil {
				return nil, net.ErrClosed
			}
			// This mux ended (its transport dropped); wait for the next one
			// instead of surfacing the error to Serve. A caller that intends to
			// keep serving detaches or replaces before or as this happens; if
			// neither occurs, this still blocks on the same mux and returns its
			// next error rather than busy-looping.
			listener.mu.Lock()
			if listener.mux == mux {
				listener.mux = nil
			}
			listener.mu.Unlock()
			continue
		}
		return NewConn(listener.ctx, stream), nil
	}
}

// Close ends the listener. It is idempotent: both the endpoint that owns the
// session lifecycle and the http.Server that owns the listener will close it,
// and the second call must not panic on an already closed channel.
func (listener *Listener) Close() error {
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		return nil
	}
	listener.closed = true
	signal := listener.replaced
	listener.mu.Unlock()
	listener.cancel()
	close(signal)
	return nil
}
func (listener *Listener) Addr() net.Addr { return streamAddr("runtime") }
