package peersession

import (
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// Entry reads one currently ready outbound attachment. It never negotiates or
// invokes a runtime owner. Holding manager.mu linearizes it with replacement,
// explicit disconnect and revocation.
func (manager *Manager) Entry(pairID string, generation uint64) (Connected, error) {
	if !protocol.ValidID(pairID) || generation == 0 {
		return Connected{}, errors.New("p2p.invalid_request")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return Connected{}, errors.New("p2p.helper_unavailable")
	}
	if _, pinned := manager.pins[pairID]; !pinned {
		return Connected{}, errors.New("p2p.pair_unauthorized")
	}
	connection := manager.sessions[pairID]
	if connection == nil {
		return Connected{}, errors.New("p2p.connection_not_found")
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	result := connection.result
	if connection.lease.Generation != 0 && connection.lease.Generation != generation {
		return Connected{}, errors.New("p2p.stale_generation")
	}
	if result.State.Stage != "ready" || connection.ctx.Err() != nil || connection.endpoint == nil || connection.mux == nil {
		return Connected{}, errors.New("p2p.not_connected")
	}
	select {
	case <-connection.mux.Done():
		return Connected{}, errors.New("p2p.not_connected")
	default:
	}
	if connection.transport != nil {
		if connection.ticket != nil && manager.client.Account() != connection.lease.UserID {
			return Connected{}, errors.New("p2p.user_unauthorized")
		}
		if !connection.transport.LiveState().Ready || connection.remoteReplaced {
			return Connected{}, errors.New("p2p.not_connected")
		}
		select {
		case <-connection.transport.Done():
			return Connected{}, errors.New("p2p.not_connected")
		default:
		}
	}
	if result.State.Generation != generation || result.State.AttemptID != connection.lease.AttemptID || connection.lease.Generation != generation {
		return Connected{}, errors.New("p2p.stale_generation")
	}
	if manager.endpoints[pairID] != connection.endpoint || connection.endpoint.CurrentMux() != connection.mux {
		return Connected{}, errors.New("p2p.stale_generation")
	}
	binding, err := connection.endpoint.Binding()
	if err != nil {
		return Connected{}, err
	}
	if binding.Generation != result.State.RuntimeGeneration || result.State.Error != "" || result.State.PairID != pairID || result.URL == "" || result.URL != connection.endpoint.LocalURL() {
		return Connected{}, errors.New("p2p.stale_generation")
	}
	if _, err := binding.Endpoint(); err != nil {
		return Connected{}, err
	}
	return result, nil
}
