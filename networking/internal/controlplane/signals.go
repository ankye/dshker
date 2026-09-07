package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

type SignalEvent struct {
	Type     string
	Lease    Lease
	Signal   protocol.Signal
	PairID   string
	Revision uint64
}

type Signals struct {
	connection *websocket.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	events     chan SignalEvent
	finished   chan struct{}
	writeMu    sync.Mutex
}

func (client *Client) Subscribe(ctx context.Context, deviceID string) (*Signals, error) {
	connection, response, err := websocket.Dial(ctx, client.endpoints.WSSURL, &websocket.DialOptions{HTTPClient: client.http, Subprotocols: []string{"dshker.signal.v1"}})
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return nil, errors.New("p2p.server_unavailable")
	}
	if connection.Subprotocol() != "dshker.signal.v1" {
		connection.CloseNow()
		return nil, errors.New("p2p.protocol_mismatch")
	}
	connection.SetReadLimit(protocol.MaxControlBytes)
	readyCtx, stop := context.WithTimeout(ctx, 10*time.Second)
	kind, data, err := connection.Read(readyCtx)
	stop()
	var ready struct {
		Type     string `json:"type"`
		Version  int    `json:"version"`
		DeviceID string `json:"deviceId"`
	}
	if err != nil || kind != websocket.MessageText || protocol.Decode(data, &ready) != nil || ready.Type != "ready" || ready.Version != protocol.Version || ready.DeviceID != deviceID {
		connection.CloseNow()
		return nil, errors.New("p2p.protocol_mismatch")
	}
	child, cancel := context.WithCancel(ctx)
	signals := &Signals{connection: connection, ctx: child, cancel: cancel, events: make(chan SignalEvent, 32), finished: make(chan struct{})}
	go signals.read()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-child.Done():
				return
			case <-ticker.C:
				var heartbeat struct {
					DeviceID string `json:"deviceId"`
					At       int64  `json:"at"`
				}
				if client.call(child, "POST", "/v1/heartbeat", "", struct{}{}, &heartbeat) != nil || heartbeat.DeviceID != deviceID {
					cancel()
					connection.CloseNow()
					return
				}
			}
		}
	}()
	return signals, nil
}

func (signals *Signals) read() {
	defer close(signals.finished)
	defer close(signals.events)
	defer signals.cancel()
	defer signals.connection.CloseNow()
	for {
		kind, data, err := signals.connection.Read(signals.ctx)
		if err != nil || kind != websocket.MessageText {
			return
		}
		var header struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &header) != nil {
			return
		}
		event := SignalEvent{Type: header.Type}
		switch header.Type {
		case "attempt":
			var value struct {
				Type  string `json:"type"`
				Lease Lease  `json:"lease"`
			}
			if protocol.Decode(data, &value) != nil {
				return
			}
			event.Lease = value.Lease
		case "signal":
			var value struct {
				Type   string          `json:"type"`
				Signal protocol.Signal `json:"signal"`
			}
			if protocol.Decode(data, &value) != nil {
				return
			}
			event.Signal = value.Signal
		case "revoked":
			var value struct {
				Type     string `json:"type"`
				PairID   string `json:"pairId"`
				Revision uint64 `json:"revision"`
			}
			if protocol.Decode(data, &value) != nil {
				return
			}
			event.PairID = value.PairID
			event.Revision = value.Revision
		default:
			return
		}
		select {
		case signals.events <- event:
		case <-signals.ctx.Done():
			return
		}
	}
}

func (signals *Signals) Events() <-chan SignalEvent { return signals.events }
func (signals *Signals) Done() <-chan struct{}      { return signals.ctx.Done() }
func (signals *Signals) Send(ctx context.Context, signal protocol.Signal) error {
	signals.writeMu.Lock()
	defer signals.writeMu.Unlock()
	data, err := json.Marshal(signal)
	if err != nil || len(data) > protocol.MaxControlBytes {
		return errors.New("p2p.protocol_limit")
	}
	if err = signals.connection.Write(ctx, websocket.MessageText, data); err != nil {
		return errors.New("p2p.server_unavailable")
	}
	return nil
}
func (signals *Signals) Close() { signals.cancel(); signals.connection.CloseNow(); <-signals.finished }
