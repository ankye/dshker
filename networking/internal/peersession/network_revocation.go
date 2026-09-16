package peersession

import (
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// RevokeNetwork is irreversible for this helper lifetime. Deleted network IDs
// cannot be repinned by an in-flight callback or a stale persisted record.
func (manager *Manager) RevokeNetwork(networkID string) error {
	if !protocol.ValidID(networkID) {
		return errors.New("p2p.invalid_request")
	}
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return errors.New("p2p.helper_unavailable")
	}
	if manager.revokedNetworks == nil {
		manager.revokedNetworks = make(map[string]struct{})
		manager.revokedPairs = make(map[string]string)
	}
	manager.revokedNetworks[networkID] = struct{}{}
	pending := make([]*session, 0)
	endpoints := make([]*runtimebridge.Endpoint, 0)
	for pairID, pin := range manager.pins {
		if pin.Pair.NetworkID != networkID {
			continue
		}
		delete(manager.pins, pairID)
		manager.revokedPairs[pairID] = networkID
		// A deleted network revokes the pair, so its gateway must stop being a
		// reachable address at once — the same rule the coordinator's revocation
		// signal follows. Keeping the port would leave a URL that still answers
		// for a network the user just removed. Both attachments go: the browsed
		// one and the one serving the far machine.
		if endpoint := manager.endpoints[pairID]; endpoint != nil {
			endpoints = append(endpoints, endpoint)
			delete(manager.endpoints, pairID)
		}
		if endpoint := manager.inboundEndpoints[pairID]; endpoint != nil {
			endpoints = append(endpoints, endpoint)
			delete(manager.inboundEndpoints, pairID)
		}
	}
	// Concurrent repeated revocations must also wait for sessions whose pins
	// were removed by the first call, including reservations before Begin.
	for pairID, connection := range manager.sessions {
		if manager.revokedPairs[pairID] == networkID {
			pending = append(pending, connection)
		}
	}
	for pairID, connection := range manager.inbound {
		if manager.revokedPairs[pairID] == networkID {
			pending = append(pending, connection)
		}
	}
	manager.mu.Unlock()
	for _, connection := range pending {
		connection.cancel()
	}
	for _, connection := range pending {
		<-connection.done
	}
	for _, endpoint := range endpoints {
		endpoint.Close()
	}
	return nil
}
