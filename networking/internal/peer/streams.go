package peer

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// StreamLink is an authenticated, reliable, ordered connection. Mux must be its
// sole message consumer. It neither creates a transport nor selects a target.
type StreamLink interface {
	Send([]byte) error
	Messages() <-chan []byte
	Done() <-chan struct{}
}

type StreamScope struct {
	AttemptID         string
	Generation        uint64
	RuntimeGeneration uint64
	Initiator         bool
}

// Mux has no filesystem, socket dial, or HTTP authority capability. Application
// owners explicitly bind accepted streams to their current runtime generation.
type Mux struct {
	mu         sync.Mutex
	link       StreamLink
	scope      StreamScope
	streams    map[uint32]*Stream
	lastLocal  uint32
	lastRemote uint32
	accepted   chan *Stream
	changed    chan struct{}
	done       chan struct{}
	err        error
}

func NewMux(link StreamLink, scope StreamScope) (*Mux, error) {
	if link == nil || !protocol.ValidID(scope.AttemptID) || scope.Generation == 0 || scope.RuntimeGeneration == 0 {
		return nil, errors.New("p2p.frame_scope_mismatch")
	}
	mux := &Mux{link: link, scope: scope, streams: make(map[uint32]*Stream), accepted: make(chan *Stream, protocol.MaxStreams), changed: make(chan struct{}), done: make(chan struct{})}
	go mux.receive()
	return mux, nil
}

func (mux *Mux) Open() (*Stream, error) {
	mux.mu.Lock()
	defer mux.mu.Unlock()
	if mux.err != nil {
		return nil, mux.err
	}
	if len(mux.streams) == protocol.MaxStreams {
		return nil, errors.New("p2p.stream_limit")
	}
	id := mux.lastLocal + 2
	if mux.lastLocal == 0 && mux.scope.Initiator {
		id = 1
	}
	if id <= mux.lastLocal {
		return nil, errors.New("p2p.stream_id_exhausted")
	}
	stream := mux.create(id)
	mux.lastLocal = id
	if err := mux.send(id, "OPEN", protocol.StreamWindowBytes, nil); err != nil {
		return nil, err
	}
	return stream, nil
}

func (mux *Mux) Accept(ctx context.Context) (*Stream, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-mux.done:
		return nil, mux.failure()
	case stream := <-mux.accepted:
		mux.mu.Lock()
		defer mux.mu.Unlock()
		if mux.err != nil {
			return nil, mux.err
		}
		if stream.err != nil {
			return nil, stream.err
		}
		return stream, nil
	}
}

func (mux *Mux) Close() error {
	mux.mu.Lock()
	defer mux.mu.Unlock()
	mux.fail(errors.New("p2p.streams_closed"))
	return nil
}

func (mux *Mux) failure() error {
	mux.mu.Lock()
	defer mux.mu.Unlock()
	return mux.err
}

func (mux *Mux) create(id uint32) *Stream {
	window, _ := protocol.NewWindow(protocol.StreamWindowBytes)
	stream := &Stream{mux: mux, id: id, receive: window, queue: make([]byte, protocol.StreamWindowBytes), writeGate: make(chan struct{}, 1)}
	mux.streams[id] = stream
	return stream
}

func (mux *Mux) send(id uint32, kind string, credit uint32, data []byte) error {
	if data == nil {
		data = []byte{}
	}
	frame := protocol.Frame{Version: protocol.Version, Type: kind, AttemptID: mux.scope.AttemptID, Generation: mux.scope.Generation, RuntimeGeneration: mux.scope.RuntimeGeneration, StreamID: id, Credit: credit, Data: data}
	encoded, err := json.Marshal(frame)
	if err == nil {
		err = mux.link.Send(encoded)
	}
	if err != nil {
		mux.fail(err)
	}
	return err
}

func (mux *Mux) notify() {
	close(mux.changed)
	mux.changed = make(chan struct{})
}

func (mux *Mux) fail(err error) {
	if mux.err != nil {
		return
	}
	mux.err = err
	for _, stream := range mux.streams {
		stream.err = err
		stream.queue = nil
	}
	clear(mux.streams)
	close(mux.done)
	mux.notify()
}

func (mux *Mux) receive() {
	for {
		select {
		case <-mux.done:
			return
		case <-mux.link.Done():
			mux.mu.Lock()
			mux.fail(errors.New("p2p.direct_closed"))
			mux.mu.Unlock()
			return
		case data, ok := <-mux.link.Messages():
			mux.mu.Lock()
			var frame protocol.Frame
			err := protocol.Decode(data, &frame)
			if !ok {
				err = errors.New("p2p.direct_closed")
			}
			if err == nil {
				err = frame.Validate(mux.scope.AttemptID, mux.scope.Generation, mux.scope.RuntimeGeneration)
			}
			if err == nil && mux.err == nil {
				err = mux.admit(frame)
			}
			if err != nil {
				mux.fail(err)
			}
			mux.mu.Unlock()
		}
	}
}

func (mux *Mux) admit(frame protocol.Frame) error {
	if frame.Type == "OPEN" {
		return mux.admitOpen(frame)
	}
	stream, found := mux.streams[frame.StreamID]
	if !found {
		// A retired id was previously admitted. Ordered in-flight data and credit
		// crossing RESET are discarded without resurrecting a stream or target.
		local := (frame.StreamID%2 == 1) == mux.scope.Initiator
		if (local && frame.StreamID <= mux.lastLocal) || (!local && frame.StreamID <= mux.lastRemote) {
			return nil
		}
		return errors.New("p2p.unknown_stream")
	}
	var err error
	switch frame.Type {
	case "DATA":
		err = stream.receive.Take(len(frame.Data))
		if err == nil {
			stream.enqueue(frame.Data)
		}
	case "WINDOW_UPDATE":
		if stream.sendWindow == nil {
			stream.sendWindow, err = protocol.NewWindow(frame.Credit)
		} else {
			err = stream.sendWindow.Return(frame.Credit)
		}
	case "FIN":
		err = stream.receive.Finish()
	case "RESET":
		stream.err = errors.New("p2p.stream_reset")
		stream.queue = nil
		delete(mux.streams, stream.id)
	}
	stream.retire()
	mux.notify()
	return err
}

func (mux *Mux) admitOpen(frame protocol.Frame) error {
	expected := mux.lastRemote + 2
	if mux.lastRemote == 0 && !mux.scope.Initiator {
		expected = 1
	}
	if expected <= mux.lastRemote || frame.StreamID != expected {
		return errors.New("p2p.invalid_stream_sequence")
	}
	window, err := protocol.NewWindow(frame.Credit)
	if err != nil {
		return err
	}
	mux.lastRemote = frame.StreamID
	if len(mux.streams) == protocol.MaxStreams || len(mux.accepted) == cap(mux.accepted) {
		return mux.send(frame.StreamID, "RESET", 0, nil)
	}
	stream := mux.create(frame.StreamID)
	stream.sendWindow = window
	if err := mux.send(stream.id, "WINDOW_UPDATE", protocol.StreamWindowBytes, nil); err != nil {
		return err
	}
	mux.accepted <- stream
	return nil
}
