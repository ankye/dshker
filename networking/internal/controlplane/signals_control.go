package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

// SubscribeControl has no v1 downgrade. A core nonce is owned by the network
// process and remains unchanged when this exact core re-subscribes.
func (client *Client) SubscribeControl(ctx context.Context, deviceID, coreID string) (*Signals, error) {
	return client.subscribeControl(ctx, deviceID, coreID, []string{protocol.CapabilityCandidate})
}

func (client *Client) SubscribeControlReadOnly(ctx context.Context, deviceID, coreID string) (*Signals, error) {
	return client.subscribeControl(ctx, deviceID, coreID, []string{})
}

func (client *Client) subscribeControl(ctx context.Context, deviceID, coreID string, capabilities []string) (*Signals, error) {
	if !protocol.ValidID(deviceID) || !protocol.ValidNonce(coreID) {
		return nil, errors.New("p2p.invalid_request")
	}
	connection, response, err := websocket.Dial(ctx, client.endpoints.WSSURL, &websocket.DialOptions{HTTPClient: client.http, Subprotocols: []string{protocol.ControlSubprotocol}})
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return nil, errors.New("p2p.server_unavailable")
	}
	if connection.Subprotocol() != protocol.ControlSubprotocol {
		connection.CloseNow()
		return nil, errors.New("p2p.protocol_mismatch")
	}
	connection.SetReadLimit(protocol.MaxControlBytes)
	budget, stop := context.WithTimeout(ctx, 10*time.Second)
	defer stop()
	userID := client.Account()
	hello := protocol.ControlHello{Version: protocol.ControlVersion, Type: "hello", UserID: userID, CoreInstanceID: coreID, Capabilities: capabilities}
	encoded, _ := json.Marshal(hello)
	if err := connection.Write(budget, websocket.MessageText, encoded); err != nil {
		connection.CloseNow()
		return nil, errors.New("p2p.server_unavailable")
	}
	kind, data, err := connection.Read(budget)
	var ready protocol.ControlReady
	if err != nil || kind != websocket.MessageText || protocol.DecodeControl(data, &ready) != nil ||
		ready.Version != protocol.ControlVersion || ready.Type != "ready" || ready.DeviceID != deviceID || ready.UserID != userID ||
		!ready.Registration.Valid() || ready.Registration.CoreInstanceID != coreID ||
		!protocol.ValidControlCapabilities(ready.Capabilities) || !protocol.HasCapability(ready.Capabilities, protocol.CapabilityCandidate) {
		connection.CloseNow()
		return nil, errors.New("p2p.protocol_mismatch")
	}
	child, cancel := context.WithCancelCause(ctx)
	signals := &Signals{connection: connection, ctx: child, cancel: cancel, events: make(chan SignalEvent, 32), finished: make(chan struct{}), healthDone: make(chan struct{}), controlReady: &ready}
	go signals.read()
	if err := signals.ping(); err != nil {
		close(signals.healthDone)
		signals.failHealth(err)
		signals.Close()
		return nil, err
	}
	signals.telemetryDone = make(chan struct{})
	go signals.maintainTelemetry(client, deviceID)
	go signals.maintainHealth(client, deviceID)
	return signals, nil
}

func (signals *Signals) Registration() (protocol.RegistrationFence, error) {
	if signals.controlReady == nil || !signals.controlReady.Registration.Valid() {
		return protocol.RegistrationFence{}, errors.New("p2p.protocol_mismatch")
	}
	select {
	case <-signals.ctx.Done():
		return protocol.RegistrationFence{}, errors.New("p2p.signalling_not_ready")
	default:
		return signals.controlReady.Registration, nil
	}
}

func (signals *Signals) SendCandidate(ctx context.Context, ticket protocol.CandidateTicket, signal protocol.Signal) error {
	if signals.controlReady == nil {
		return errors.New("p2p.protocol_mismatch")
	}
	value := protocol.CandidateSignal{Version: protocol.ControlVersion, Type: "signal", Ticket: ticket, Signal: signal}
	data, err := json.Marshal(value)
	if err != nil || len(data) > protocol.MaxControlBytes {
		return errors.New("p2p.protocol_limit")
	}
	signals.writeMu.Lock()
	defer signals.writeMu.Unlock()
	if err := signals.connection.Write(ctx, websocket.MessageText, data); err != nil {
		return errors.New("p2p.server_unavailable")
	}
	return nil
}

func decodeControlEvent(data []byte) (SignalEvent, bool, error) {
	var header struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &header) != nil {
		return SignalEvent{}, false, errors.New("p2p.protocol_mismatch")
	}
	event := SignalEvent{Type: header.Type}
	var err error
	switch header.Type {
	case "candidate":
		var value protocol.CandidatePreparedEvent
		err = protocol.DecodeControl(data, &value)
		event.Ticket = value.Ticket
		if value.Version != protocol.ControlVersion {
			err = errors.New("p2p.protocol_mismatch")
		}
	case "candidate-decision":
		var value protocol.CandidateDecisionEvent
		err = protocol.DecodeControl(data, &value)
		event.State = value.State
		if value.Version != protocol.ControlVersion {
			err = errors.New("p2p.protocol_mismatch")
		}
	case "peer-registration":
		err = protocol.DecodeControl(data, &event.Registration)
		if event.Registration.Version != protocol.ControlVersion {
			err = errors.New("p2p.protocol_mismatch")
		}
	case "signal":
		var value protocol.CandidateSignal
		err = protocol.DecodeControl(data, &value)
		event.Signal, event.Ticket = value.Signal, value.Ticket
		if value.Version != protocol.ControlVersion {
			err = errors.New("p2p.protocol_mismatch")
		}
	case "revoked":
		var value struct {
			Version  int    `json:"version"`
			Type     string `json:"type"`
			PairID   string `json:"pairId"`
			Revision uint64 `json:"revision"`
		}
		err = protocol.DecodeControl(data, &value)
		event.PairID, event.Revision = value.PairID, value.Revision
		if value.Version != protocol.ControlVersion || !protocol.ValidID(value.PairID) {
			err = errors.New("p2p.protocol_mismatch")
		}
	default:
		return event, false, errors.New("p2p.protocol_mismatch")
	}
	return event, true, err
}

func (signals *Signals) publish(event SignalEvent) bool {
	select {
	case signals.events <- event:
		return true
	case <-signals.ctx.Done():
		return false
	default:
		signals.cancel(errors.New("p2p.signal_limit"))
		return false
	}
}
