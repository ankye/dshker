package peer

import (
	"context"
	"errors"
	"io"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// Stream is a bounded, half-closeable byte stream, not an arbitrary TCP proxy.
// Read/Write wait on credit/data with explicit caller cancellation.
type Stream struct {
	mux         *Mux
	id          uint32
	writeGate   chan struct{}
	receive     *protocol.Window
	sendWindow  *protocol.Window
	queue       []byte
	readIndex   int
	buffered    int
	writeClosed bool
	err         error
}

func (stream *Stream) ID() uint32 { return stream.id }

func (stream *Stream) Read(ctx context.Context, target []byte) (int, error) {
	if len(target) == 0 {
		return 0, nil
	}
	mux := stream.mux
	mux.mu.Lock()
	defer mux.mu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if stream.err != nil {
			return 0, stream.err
		}
		if stream.buffered > 0 {
			return stream.consume(target)
		}
		if stream.receive.Drained() {
			return 0, io.EOF
		}
		if err := stream.wait(ctx); err != nil {
			return 0, err
		}
	}
}

func (stream *Stream) consume(target []byte) (int, error) {
	size := min(len(target), stream.buffered)
	first := copy(target[:size], stream.queue[stream.readIndex:])
	copy(target[first:size], stream.queue[:size-first])
	stream.readIndex = (stream.readIndex + size) % len(stream.queue)
	stream.buffered -= size
	if err := stream.receive.Return(uint32(size)); err != nil {
		return 0, err
	}
	if err := stream.mux.send(stream.id, "WINDOW_UPDATE", uint32(size), nil); err != nil {
		return size, err
	}
	stream.retire()
	return size, nil
}

func (stream *Stream) Write(ctx context.Context, data []byte) (int, error) {
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case stream.writeGate <- struct{}{}:
	}
	defer func() { <-stream.writeGate }()
	mux := stream.mux
	mux.mu.Lock()
	defer mux.mu.Unlock()
	written := 0
	for written < len(data) {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		if stream.err != nil {
			return written, stream.err
		}
		if stream.writeClosed {
			return written, errors.New("p2p.stream_finished")
		}
		if stream.sendWindow == nil || stream.sendWindow.Available() == 0 {
			if err := stream.wait(ctx); err != nil {
				return written, err
			}
			continue
		}
		size := min(len(data)-written, protocol.MaxDataBytes, int(stream.sendWindow.Available()))
		if err := stream.sendWindow.Take(size); err != nil {
			return written, err
		}
		if err := mux.send(stream.id, "DATA", 0, data[written:written+size]); err != nil {
			return written, err
		}
		written += size
	}
	return written, nil
}

func (stream *Stream) wait(ctx context.Context) error {
	mux := stream.mux
	changed := mux.changed
	mux.mu.Unlock()
	select {
	case <-ctx.Done():
	case <-changed:
	}
	mux.mu.Lock()
	return ctx.Err()
}

func (stream *Stream) CloseWrite() error {
	mux := stream.mux
	mux.mu.Lock()
	defer mux.mu.Unlock()
	if stream.err != nil {
		return stream.err
	}
	if stream.writeClosed {
		return nil
	}
	stream.writeClosed = true
	if err := mux.send(stream.id, "FIN", 0, nil); err != nil {
		return err
	}
	stream.retire()
	mux.notify()
	return nil
}

func (stream *Stream) Close() error {
	mux := stream.mux
	mux.mu.Lock()
	defer mux.mu.Unlock()
	if stream.err != nil {
		return nil
	}
	_, active := mux.streams[stream.id]
	stream.err = errors.New("p2p.stream_closed")
	stream.queue = nil
	delete(mux.streams, stream.id)
	mux.notify()
	if active {
		return mux.send(stream.id, "RESET", 0, nil)
	}
	return nil
}

func (stream *Stream) retire() {
	if stream.writeClosed && stream.receive.Drained() {
		stream.queue = nil
		delete(stream.mux.streams, stream.id)
	}
}

func (stream *Stream) enqueue(data []byte) {
	index := (stream.readIndex + stream.buffered) % len(stream.queue)
	first := copy(stream.queue[index:], data)
	copy(stream.queue, data[first:])
	stream.buffered += len(data)
}
