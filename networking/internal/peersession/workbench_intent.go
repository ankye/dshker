package peersession

// WorkbenchRequested reports admitted local outbound intent. Incoming sessions
// never create this intent; transient failures never clear it.
func (manager *Manager) WorkbenchRequested(pairID string) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	_, pinned := manager.pins[pairID]
	return !manager.closed && pinned && manager.workbenches[pairID]
}
