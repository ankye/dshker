package peersession

import (
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func (manager *Manager) peerRegistration(event protocol.PeerRegistration) {
	fence, err := manager.registration()
	if err != nil || event.Version != protocol.ControlVersion || event.ServerEpoch != fence.ServerEpoch || !protocol.ValidID(event.DeviceID) || (event.UserID != "" && !protocol.ValidID(event.UserID)) || !protocol.ValidNonce(event.CoreInstanceID) || !protocol.ValidControlCapabilities(event.Capabilities) {
		return
	}
	manager.mu.Lock()
	if manager.peerCores == nil {
		manager.peerCores = make(map[string]string)
	}
	manager.peerCores[event.DeviceID] = event.CoreInstanceID
	var states []State
	var wake []string
	for pairID, pin := range manager.pins {
		remote, err := manager.targetDevice(pin)
		if err != nil || remote != event.DeviceID {
			continue
		}
		wake = append(wake, pairID)
		for _, primary := range []*session{manager.sessions[pairID], manager.inbound[pairID]} {
			if primary == nil || primary.ticket == nil || !event.Online {
				continue
			}
			core := primary.ticket.ToCoreInstanceID
			if primary.lease.ToDeviceID == manager.config.Device.DeviceID {
				core = primary.ticket.FromCoreInstanceID
			}
			if core == event.CoreInstanceID && event.UserID == primary.lease.UserID {
				continue
			}
			primary.remoteReplaced = true
			state := connectionState(primary)
			if state.Stage == "ready" || state.Stage == "connected" {
				state.Stage, state.Error = "suspended", ""
				primary.mu.Lock()
				primary.result.State = state
				primary.mu.Unlock()
				if primary == manager.sessions[pairID] {
					states = append(states, state)
				}
			}
		}
	}
	manager.mu.Unlock()
	for _, state := range states {
		manager.emitCurrent(state)
	}
	for _, pairID := range wake {
		manager.wake(pairID)
	}
	if manager.config.PeerRegistration != nil {
		manager.config.PeerRegistration(event)
	}
}

// CurrentState is the primary's live truth. A candidate never replaces it in
// projection until an authoritative committed decision is locally promoted.
func (manager *Manager) CurrentState(pairID string) (State, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return State{}, errors.New("p2p.helper_unavailable")
	}
	connection := manager.sessions[pairID]
	if connection == nil {
		connection = manager.candidates[pairID]
	}
	if connection == nil {
		return State{}, errors.New("p2p.connection_not_found")
	}
	state := connectionState(connection)
	if connection.promoted && (state.Stage == "ready" || state.Stage == "connected") && (connection.remoteReplaced || !connection.transport.LiveState().Ready) {
		state.Stage, state.Error = "suspended", ""
	}
	return state, nil
}
