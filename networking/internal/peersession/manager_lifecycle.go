package peersession

import (
	"errors"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// finish retires a session exactly once.
//
// Both the connecting caller and the session runner can reach it — the caller
// abandons an attempt whose transport failed while the runner is still unwinding
// — and closing an already closed channel panics the whole core, which takes
// every pair down with it until the application is restarted. The once also
// keeps the waiters correct: whoever arrives second still observes a closed
// done.
func (manager *Manager) finish(pairID string, connection *session) {
	connection.cancel()
	manager.mu.Lock()
	if manager.sessions[pairID] == connection {
		delete(manager.sessions, pairID)
	}
	if manager.inbound[pairID] == connection {
		delete(manager.inbound, pairID)
	}
	if manager.candidates[pairID] == connection {
		delete(manager.candidates, pairID)
	}
	if manager.inboundCandidates[pairID] == connection {
		delete(manager.inboundCandidates, pairID)
	}
	if admission := manager.inboundAdmissions[pairID]; admission != nil && admission.connection == connection {
		delete(manager.inboundAdmissions, pairID)
	}
	delete(manager.retiring, connection)
	manager.mu.Unlock()
	connection.finishOnce.Do(func() { close(connection.done) })
}
func (manager *Manager) Disconnect(pairID string) error {
	manager.mu.Lock()
	manager.cancelManualWaitLocked(pairID, "p2p.connection_cancelled")
	delete(manager.workbenches, pairID)
	endpoint := manager.endpoints[pairID]
	connection, exists := manager.sessions[pairID]
	candidate := manager.candidates[pairID]
	var ownedMux *peer.Mux
	if endpoint != nil {
		ownedMux = endpoint.CurrentMux()
	}
	if connection != nil {
		connection.mu.Lock()
		if connection.endpoint != nil {
			endpoint, ownedMux = connection.endpoint, connection.mux
		}
		connection.mu.Unlock()
	}
	if endpoint != nil {
		endpoint.Detach(ownedMux)
	}
	manager.mu.Unlock()
	if !exists && candidate == nil {
		return errors.New("p2p.not_connected")
	}
	for _, current := range []*session{connection, candidate} {
		if current != nil {
			current.stop("explicit_disconnect", nil)
		}
	}
	for _, current := range []*session{connection, candidate} {
		if current == nil {
			continue
		}
		manager.endCandidate(current, "disconnect")
		<-current.done
	}
	return nil
}

func (manager *Manager) InvalidateRuntime(generation uint64) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	// InvalidateRuntime is asked to drop the sessions bound to a runtime this
	// device serves, which are the answered ones; the dialled ones browse the
	// far side's runtime and cannot be bound to a local generation.
	for _, connection := range manager.servedSessionsLocked() {
		if connection.transport == nil {
			if admission := manager.inboundAdmissions[connection.PairID]; admission != nil && admission.connection == connection {
				connection.stop("runtime_invalidated", errors.New("p2p.runtime_invalidated"))
			}
			continue
		}
		connection.mu.Lock()
		matches := connection.result.State.RuntimeGeneration == 0 || connection.result.State.RuntimeGeneration == generation
		connection.mu.Unlock()
		if matches {
			connection.stop("runtime_invalidated", errors.New("p2p.runtime_invalidated"))
		}
	}
}
func (manager *Manager) Close() {
	manager.mu.Lock()
	manager.closed = true
	manager.cancelAllManualWaitsLocked("p2p.helper_unavailable")
	clear(manager.workbenches)
	signals := manager.signals
	pending := make([]<-chan struct{}, 0, len(manager.sessions)+len(manager.inbound))
	for _, connection := range manager.allSessionsLocked() {
		connection.noteStop("manager_closed", nil)
		pending = append(pending, connection.done)
	}
	endpoints := make([]*runtimebridge.Endpoint, 0, len(manager.endpoints)+len(manager.inboundEndpoints))
	for _, endpoint := range manager.endpoints {
		endpoints = append(endpoints, endpoint)
	}
	for _, endpoint := range manager.inboundEndpoints {
		endpoints = append(endpoints, endpoint)
	}
	manager.endpoints = make(map[string]*runtimebridge.Endpoint)
	manager.inboundEndpoints = make(map[string]*runtimebridge.Endpoint)
	manager.mu.Unlock()
	manager.cancel()
	if signals != nil {
		signals.close()
	}
	for _, done := range pending {
		<-done
	}
	manager.inboundAdmissionWait.Wait()
	manager.endWait.Wait()
	// Every gateway this manager ever opened ends with it: the process losing
	// its P2P session is not a drop the shell will reconnect from, unlike a
	// session inside a still-pinned pair dropping.
	for _, endpoint := range endpoints {
		endpoint.Close()
	}
}

// revoke drops a pair's authorization and everything that depended on it.
//
// Extracted from the signal loop because it is the one place a gateway is
// deliberately destroyed rather than kept for the next reconnect, and that
// decision has to be testable on its own.
func (manager *Manager) revoke(pairID string) {
	_ = manager.revokeExpected(pairID, "")
}

func (manager *Manager) revokeExpected(pairID, networkID string) error {
	manager.mu.Lock()
	pin, pinned := manager.pins[pairID]
	if pinned && networkID != "" && pin.Pair.NetworkID != networkID {
		manager.mu.Unlock()
		return errors.New("p2p.network_selection_conflict")
	}
	manager.cancelManualWaitLocked(pairID, "p2p.pair_revoked")
	delete(manager.pins, pairID)
	delete(manager.workbenches, pairID)
	if pinned {
		// Record the network the way RevokeNetwork does, so a session still being
		// reserved for this pair is closed too instead of outliving its
		// authorization.
		if manager.revokedPairs == nil {
			manager.revokedPairs = make(map[string]string)
		}
		manager.revokedPairs[pairID] = pin.Pair.NetworkID
	}
	endpoint := manager.endpoints[pairID]
	served := manager.inboundEndpoints[pairID]
	delete(manager.endpoints, pairID)
	delete(manager.inboundEndpoints, pairID)
	connection := manager.sessions[pairID]
	answered := manager.inbound[pairID]
	candidate, inboundCandidate := manager.candidates[pairID], manager.inboundCandidates[pairID]
	admission := manager.inboundAdmissions[pairID]
	// Losing authorization also loses current ownership in this same barrier.
	// The retiring set retains cleanup/Close responsibility without allowing an
	// old deferred callback to project ready into a replacement account/network.
	if manager.retiring == nil {
		manager.retiring = make(map[*session]struct{})
	}
	for _, slots := range []map[string]*session{manager.sessions, manager.inbound, manager.candidates, manager.inboundCandidates} {
		if current := slots[pairID]; current != nil {
			current.scopeRetired = true
			manager.retiring[current] = struct{}{}
			delete(slots, pairID)
		}
	}
	if admission != nil {
		admission.connection.scopeRetired = true
		manager.retiring[admission.connection] = struct{}{}
		admission.connection.stop("pair_revoked", errors.New("p2p.pair_revoked"))
	}
	manager.mu.Unlock()
	// Closed outside the lock: a revoked pair must lose its reachable address at
	// once, including when no session was live, and Close reaches into the
	// gateway's own locks.
	if connection != nil {
		connection.stop("pair_revoked", errors.New("p2p.pair_revoked"))
	}
	if answered != nil {
		answered.stop("pair_revoked", errors.New("p2p.pair_revoked"))
	}
	if candidate != nil {
		candidate.stop("pair_revoked", errors.New("p2p.pair_revoked"))
	}
	if inboundCandidate != nil {
		inboundCandidate.stop("pair_revoked", errors.New("p2p.pair_revoked"))
	}
	if endpoint != nil {
		endpoint.Close()
	}
	if served != nil {
		served.Close()
	}
	return nil
}

func (manager *Manager) allSessionsLocked() []*session {
	var sessions []*session
	seen := make(map[*session]bool)
	add := func(connection *session) {
		if !seen[connection] {
			seen[connection] = true
			sessions = append(sessions, connection)
		}
	}
	for _, slots := range []map[string]*session{manager.sessions, manager.inbound, manager.candidates, manager.inboundCandidates} {
		for _, connection := range slots {
			add(connection)
		}
	}
	for connection := range manager.retiring {
		add(connection)
	}
	for _, admission := range manager.inboundAdmissions {
		add(admission.connection)
	}
	return sessions
}

func (manager *Manager) servedSessionsLocked() []*session {
	var sessions []*session
	for _, slots := range []map[string]*session{manager.inbound, manager.inboundCandidates} {
		for _, connection := range slots {
			sessions = append(sessions, connection)
		}
	}
	for _, admission := range manager.inboundAdmissions {
		sessions = append(sessions, admission.connection)
	}
	return sessions
}
