package peersession

import (
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
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
	for pairID, pin := range manager.pins {
		if pin.Pair.NetworkID != networkID {
			continue
		}
		delete(manager.pins, pairID)
		manager.revokedPairs[pairID] = networkID
	}
	// Concurrent repeated revocations must also wait for sessions whose pins
	// were removed by the first call, including reservations before Begin.
	for pairID, connection := range manager.sessions {
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
	return nil
}
