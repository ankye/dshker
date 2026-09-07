// Package localrpc is the private, versioned main/helper channel, not a network API.
package localrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

type Frame struct {
	Version int             `json:"version"`
	ID      uint64          `json:"id"`
	Method  string          `json:"method"`
	Payload json.RawMessage `json:"payload"`
	Error   string          `json:"error"`
}
type Handler func(context.Context, string, json.RawMessage) (any, error)
type Peer struct {
	conn       net.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	writeMu    sync.Mutex
	callMu     sync.Mutex
	mu         sync.Mutex
	next, last uint64
	pending    map[uint64]chan Frame
	slots      chan struct{}
	handler    Handler
	done       chan struct{}
}

func New(parent context.Context, conn net.Conn, handler Handler) *Peer {
	ctx, cancel := context.WithCancel(parent)
	peer := &Peer{conn: conn, ctx: ctx, cancel: cancel, pending: make(map[uint64]chan Frame), slots: make(chan struct{}, 16), handler: handler, done: make(chan struct{})}
	go peer.read()
	go func() { <-ctx.Done(); conn.Close() }()
	return peer
}
func (peer *Peer) Done() <-chan struct{} { return peer.done }
func (peer *Peer) Close()                { peer.cancel(); peer.conn.Close(); <-peer.done }

func (peer *Peer) Call(ctx context.Context, method string, payload any) (json.RawMessage, error) {
	if method == "" || len(method) > 80 {
		return nil, errors.New("p2p.invalid_operation")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, errors.New("p2p.invalid_payload")
	}
	// Request IDs must be allocated in the same order they reach the wire.
	peer.callMu.Lock()
	if ctx.Err() != nil {
		peer.callMu.Unlock()
		return nil, ctx.Err()
	}
	peer.mu.Lock()
	if len(peer.pending) >= 16 || peer.next >= 9007199254740991 {
		peer.mu.Unlock()
		peer.callMu.Unlock()
		return nil, errors.New("p2p.helper_busy")
	}
	peer.next++
	id := peer.next
	result := make(chan Frame, 1)
	peer.pending[id] = result
	peer.mu.Unlock()
	defer func() { peer.mu.Lock(); delete(peer.pending, id); peer.mu.Unlock() }()
	err = peer.write(Frame{Version: 1, ID: id, Method: method, Payload: data, Error: ""})
	peer.callMu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-peer.ctx.Done():
		return nil, errors.New("p2p.helper_unavailable")
	case response := <-result:
		if response.Error != "" {
			return nil, errors.New(response.Error)
		}
		return response.Payload, nil
	}
}

func (peer *Peer) write(frame Frame) error {
	data, err := json.Marshal(frame)
	if err != nil || len(data) > protocol.MaxControlBytes {
		return errors.New("p2p.protocol_limit")
	}
	peer.writeMu.Lock()
	defer peer.writeMu.Unlock()
	peer.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	data = append(data, '\n')
	for len(data) > 0 {
		n, err := peer.conn.Write(data)
		if err != nil || n == 0 {
			peer.cancel()
			return errors.New("p2p.helper_unavailable")
		}
		data = data[n:]
	}
	return nil
}

func (peer *Peer) read() {
	defer close(peer.done)
	defer peer.cancel()
	scanner := bufio.NewScanner(peer.conn)
	scanner.Buffer(make([]byte, 4096), protocol.MaxControlBytes+1)
	for scanner.Scan() {
		var frame Frame
		if protocol.Decode(scanner.Bytes(), &frame) != nil || frame.Version != 1 || frame.ID == 0 || frame.ID > 9007199254740991 || len(frame.Method) > 80 {
			return
		}
		if frame.Method == "" {
			if frame.Error != "" && publicError(errors.New(frame.Error)) != frame.Error {
				return
			}
			peer.mu.Lock()
			pending := peer.pending[frame.ID]
			delete(peer.pending, frame.ID)
			peer.mu.Unlock()
			if pending != nil {
				pending <- frame
			}
			continue
		}
		if frame.ID <= peer.last || frame.Error != "" {
			return
		}
		peer.last = frame.ID
		select {
		case peer.slots <- struct{}{}:
			go peer.handle(frame)
		default:
			if peer.write(Frame{Version: 1, ID: frame.ID, Payload: json.RawMessage(`{}`), Error: "p2p.helper_busy"}) != nil {
				return
			}
		}
	}
}

func (peer *Peer) handle(frame Frame) {
	defer func() { <-peer.slots }()
	ctx, cancel := context.WithTimeout(peer.ctx, 90*time.Second)
	defer cancel()
	value, err := peer.handler(ctx, frame.Method, frame.Payload)
	response := Frame{Version: 1, ID: frame.ID, Payload: json.RawMessage(`{}`)}
	if err != nil {
		response.Error = publicError(err)
	} else {
		response.Payload, err = json.Marshal(value)
		if err != nil || string(response.Payload) == "null" {
			response.Payload = json.RawMessage(`{}`)
			response.Error = "p2p.invalid_result"
		}
	}
	peer.write(response)
}

func publicError(err error) string {
	value := err.Error()
	if len(value) < 5 || len(value) > 96 || value[:4] != "p2p." {
		return "p2p.operation_failed"
	}
	for _, c := range value[4:] {
		if (c < 'a' || c > 'z') && c != '_' && c != '.' {
			return "p2p.operation_failed"
		}
	}
	return value
}
