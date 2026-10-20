package peersession

// OwnsState rejects late announcements from a session its direction replaced.
func (manager *Manager) OwnsState(state State) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	connection := manager.sessions[state.PairID]
	if connection == nil {
		connection = manager.candidates[state.PairID]
	}
	if manager.closed || connection == nil || connection.lease.AttemptID != state.AttemptID || connection.lease.Generation != state.Generation {
		return false
	}
	return connection.ticket == nil || connectionState(connection) == state
}
