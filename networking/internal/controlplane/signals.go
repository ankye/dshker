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

// SignalSuperseded is the coordinator's close reason when this device opened a
// newer signalling socket and this one was displaced.
//
// A wire contract shared with the coordinator's `signalSuperseded`. One device
// holds exactly one signalling socket — the id is derived from its public key and
// the socket is authenticated by mTLS — so the newest connection is the live one
// and the displaced side must stand down instead of reconnecting. Without this
// distinction a displacement is indistinguishable from a dropped network, and the
// two sockets kick each other off forever.
const SignalSuperseded = "p2p.signal_superseded"

type Signals struct {
	connection *websocket.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	events     chan SignalEvent
	finished   chan struct{}
	writeMu    sync.Mutex

	// closeMu guards the close reason the read loop recorded when it ended.
	closeMu     sync.Mutex
	closeReason string
}

// Superseded reports whether the coordinator closed this subscription because the
// same device opened a newer one. A caller seeing true must not re-subscribe.
func (signals *Signals) Superseded() bool {
	signals.closeMu.Lock()
	defer signals.closeMu.Unlock()
	return signals.closeReason == SignalSuperseded
}

// recordClose remembers the coordinator's stated reason for ending the socket.
func (signals *Signals) recordClose(err error) {
	var closeError websocket.CloseError
	if !errors.As(err, &closeError) {
		return
	}
	signals.closeMu.Lock()
	signals.closeReason = closeError.Reason
	signals.closeMu.Unlock()
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
	// Presence is registered before this call returns. The coordinator authorizes a
	// connection attempt against presence, so a subscription that has not reported
	// yet would make the very first attempt — by this machine or toward it — look
	// like an offline peer, which is a race no retry loop should have to paper over.
	if !client.beat(child, connection, deviceID, cancel) {
		return nil, errors.New("p2p.server_unavailable")
	}
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-child.Done():
				return
			case <-ticker.C:
				if !client.beat(child, connection, deviceID, cancel) {
					return
				}
			}
		}
	}()
	return signals, nil
}

// beat sends one heartbeat and reports whether the control connection survives it.
func (client *Client) beat(ctx context.Context, connection *websocket.Conn, deviceID string, cancel context.CancelFunc) bool {
	var heartbeat struct {
		DeviceID string `json:"deviceId"`
		At       int64  `json:"at"`
	}
	// The heartbeat carries this build's own description so the coordinator's device
	// directory can tell deployments apart, and the account this machine is signed
	// in to, because presence belongs to an account: signed in nowhere reports none
	// and reads as offline.
	if client.call(ctx, "POST", "/v1/heartbeat", "", client.heartbeat(), &heartbeat) != nil || heartbeat.DeviceID != deviceID {
		cancel()
		connection.CloseNow()
		return false
	}
	return true
}

func (signals *Signals) read() {
	defer close(signals.finished)
	defer close(signals.events)
	defer signals.cancel()
	defer signals.connection.CloseNow()
	for {
		kind, data, err := signals.connection.Read(signals.ctx)
		if err != nil || kind != websocket.MessageText {
			// Keep the coordinator's stated reason before unwinding: it is the only
			// way the supervisor can tell a displacement from a lost network and
			// avoid reconnecting into a kick-loop.
			signals.recordClose(err)
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
			// An event this build does not know is not a reason to tear down the
			// control connection: dropping the subscription here silently killed
			// every future pairing (nothing reconnects a closed event channel on
			// the caller side) and a coordinator that grows a new event type
			// would break every older launcher. Skip it and keep reading.
			continue
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
