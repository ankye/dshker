package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"log"
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

const (
	signalHeartbeatInterval = 10 * time.Second
	signalPongTimeout       = 5 * time.Second
)

// Keep the public refusal code separate from the failed carrier and its cause.
// In particular, an HTTPS presence reply cannot establish WebSocket health.
type signalHealthError struct {
	channel string
	code    string
	cause   error
}

func (failure *signalHealthError) Error() string { return failure.code }
func (failure *signalHealthError) Unwrap() error { return failure.cause }

type Signals struct {
	connection *websocket.Conn
	ctx        context.Context
	cancel     context.CancelCauseFunc
	events     chan SignalEvent
	finished   chan struct{}
	healthDone chan struct{}
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
	var closed websocket.CloseError
	if errors.As(err, &closed) && closed.Reason == SignalSuperseded {
		connection.CloseNow()
		return nil, errors.New(SignalSuperseded)
	}
	if err != nil || kind != websocket.MessageText || protocol.Decode(data, &ready) != nil || ready.Type != "ready" || ready.Version != protocol.Version || ready.DeviceID != deviceID {
		connection.CloseNow()
		return nil, errors.New("p2p.protocol_mismatch")
	}
	child, cancel := context.WithCancelCause(ctx)
	signals := &Signals{connection: connection, ctx: child, cancel: cancel, events: make(chan SignalEvent, 32), finished: make(chan struct{}), healthDone: make(chan struct{})}
	go signals.read()
	// Presence is registered before this call returns. The coordinator authorizes a
	// connection attempt against presence, so a subscription that has not reported
	// yet would make the very first attempt — by this machine or toward it — look
	// like an offline peer, which is a race no retry loop should have to paper over.
	if err := signals.beat(client, deviceID); err != nil {
		close(signals.healthDone)
		signals.failHealth(err)
		signals.Close()
		return nil, signals.Err()
	}
	go signals.maintainHealth(client, deviceID)
	return signals, nil
}

// beat proves both presence admission and the actual signalling carrier. Ping
// waits for the read goroutine to process its matching Pong, even on an idle socket.
func (signals *Signals) beat(client *Client, deviceID string) error {
	var heartbeat struct {
		DeviceID string `json:"deviceId"`
		At       int64  `json:"at"`
	}
	// The heartbeat carries this build's own description so the coordinator's device
	// directory can tell deployments apart, and the account this machine is signed
	// in to, because presence belongs to an account: signed in nowhere reports none
	// and reads as offline.
	if err := client.call(signals.ctx, "POST", "/v1/heartbeat", "", client.heartbeat(), &heartbeat); err != nil {
		return &signalHealthError{channel: "https", code: err.Error(), cause: err}
	}
	if heartbeat.DeviceID != deviceID {
		return &signalHealthError{channel: "https", code: "p2p.identity_mismatch"}
	}
	pingCtx, cancel := context.WithTimeout(signals.ctx, signalPongTimeout)
	defer cancel()
	if err := signals.connection.Ping(pingCtx); err != nil {
		return &signalHealthError{channel: "websocket", code: "p2p.server_unavailable", cause: err}
	}
	return nil
}

func (signals *Signals) maintainHealth(client *Client, deviceID string) {
	defer close(signals.healthDone)
	ticker := time.NewTicker(signalHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-signals.ctx.Done():
			return
		case <-ticker.C:
			if err := signals.beat(client, deviceID); err != nil {
				signals.failHealth(err)
				return
			}
		}
	}
}

func (signals *Signals) failHealth(err error) {
	signals.stop(err)
	// The reader can still be finalizing an explicit coordinator Close frame.
	// Do not log its supersession or an earlier refusal as a heartbeat failure.
	<-signals.finished
	var trigger, failure *signalHealthError
	if errors.As(err, &trigger) && errors.As(signals.Err(), &failure) && failure == trigger {
		log.Printf("[p2p] signalling %s heartbeat failed: %s", failure.channel, failure.code)
	}
}

func (signals *Signals) stop(cause error) {
	signals.cancel(cause)
	signals.connection.CloseNow()
}

func (signals *Signals) read() {
	defer close(signals.finished)
	defer close(signals.events)
	defer signals.stop(context.Canceled)
	for {
		kind, data, err := signals.connection.Read(signals.ctx)
		if err != nil {
			// Keep the coordinator's stated reason before unwinding: it is the only
			// way the supervisor can tell a displacement from a lost network and
			// avoid reconnecting into a kick-loop.
			signals.recordClose(err)
			signals.failRead(err, "p2p.server_unavailable")
			return
		}
		if kind != websocket.MessageText {
			signals.failRead(nil, "p2p.protocol_mismatch")
			return
		}
		var header struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &header); err != nil {
			signals.failRead(err, "p2p.protocol_mismatch")
			return
		}
		event := SignalEvent{Type: header.Type}
		switch header.Type {
		case "attempt":
			var value struct {
				Type  string `json:"type"`
				Lease Lease  `json:"lease"`
			}
			if err := protocol.Decode(data, &value); err != nil {
				signals.failRead(err, "p2p.protocol_mismatch")
				return
			}
			event.Lease = value.Lease
		case "signal":
			var value struct {
				Type   string          `json:"type"`
				Signal protocol.Signal `json:"signal"`
			}
			if err := protocol.Decode(data, &value); err != nil {
				signals.failRead(err, "p2p.protocol_mismatch")
				return
			}
			event.Signal = value.Signal
		case "revoked":
			var value struct {
				Type     string `json:"type"`
				PairID   string `json:"pairId"`
				Revision uint64 `json:"revision"`
			}
			if err := protocol.Decode(data, &value); err != nil {
				signals.failRead(err, "p2p.protocol_mismatch")
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
		default:
			// A slow event consumer must not prevent this reader from handling Pong
			// or coordinator Close frames. End this bounded subscription explicitly;
			// continuing after dropping an admitted signal would corrupt negotiation.
			err := errors.New("p2p.signal_limit")
			log.Printf("[p2p] signalling event queue exceeded its limit: %s", err)
			signals.cancel(err)
			return
		}
	}
}

func (signals *Signals) failRead(err error, code string) {
	if signals.Superseded() {
		code = SignalSuperseded
	} else if typed, ok := protocol.Refusal(err); ok {
		code = typed
	}
	// CancelCause keeps owner cancellation or an earlier specific failure intact.
	signals.cancel(&signalHealthError{channel: "websocket", code: code, cause: err})
}

func (signals *Signals) Events() <-chan SignalEvent { return signals.events }

// Publish loss only after the reader has recorded the coordinator's close reason.
// A concurrent Ping can observe the socket closing before Read returns CloseError;
// publishing ctx.Done then would let a supervisor miss an explicit supersession.
func (signals *Signals) Done() <-chan struct{} { return signals.finished }

// Err preserves the first local failure and the coordinator's explicit
// supersession reason even when a heartbeat concurrently observes the closure.
func (signals *Signals) Err() error {
	if signals.Superseded() {
		return errors.New(SignalSuperseded)
	}
	return context.Cause(signals.ctx)
}

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
func (signals *Signals) Close() {
	signals.stop(context.Canceled)
	<-signals.finished
	<-signals.healthDone
}
