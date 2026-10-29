package peersession

import "github.com/ankye/dshker/networking/internal/protocol"

// OwnsState rejects late announcements from a session its direction replaced.
func (manager *Manager) OwnsState(state State) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	connection := manager.sessions[state.PairID]
	if connection == nil {
		connection = manager.candidates[state.PairID]
	}
	if manager.closed || connection == nil {
		return false
	}
	if connection.ticket == nil && connection.prepare != nil {
		request := connection.prepare
		return protocol.ValidNonce(request.AttemptID) && state == connectionState(connection) &&
			state == (State{PairID: connection.PairID, AttemptID: request.AttemptID, Generation: request.Generation, Stage: "punching"})
	}
	if connection.lease.AttemptID != state.AttemptID || connection.lease.Generation != state.Generation {
		return false
	}
	return connection.ticket == nil || connectionState(connection) == state
}
