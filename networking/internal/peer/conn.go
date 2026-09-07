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
type Listener struct {
	mux    *Mux
	ctx    context.Context
	cancel context.CancelFunc
}

func NewListener(ctx context.Context, mux *Mux) *Listener {
	child, cancel := context.WithCancel(ctx)
	return &Listener{mux: mux, ctx: child, cancel: cancel}
}
func (listener *Listener) Accept() (net.Conn, error) {
	stream, err := listener.mux.Accept(listener.ctx)
	if err != nil {
		return nil, err
	}
	return NewConn(listener.ctx, stream), nil
}
func (listener *Listener) Close() error   { listener.cancel(); return nil }
func (listener *Listener) Addr() net.Addr { return streamAddr("runtime") }
