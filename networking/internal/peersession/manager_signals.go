package peersession

import (
	"context"
	"errors"
)

// ReconnectSignals repairs the coordinator subscription when its socket was
// displaced by a newer process or became unusable while the daemon itself stayed
// alive. A manager used to stand down permanently in that state: every later
// peer.connect returned p2p.server_unavailable until the whole launcher restarted.
// The caller invokes this only from an explicit/core reconciliation pass, so a
// healthy socket is never replaced and two healthy processes do not continuously
// kick each other off.
func (manager *Manager) ReconnectSignals(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Only one caller may replace a displaced subscription. Reconciliation and
	// an explicit retry can arrive together; without this lock they both dial,
	// and the later socket displaces the one already installed by the first.
	manager.reconnectMu.Lock()
	defer manager.reconnectMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return errors.New("p2p.helper_unavailable")
	}
	current := manager.signals
	manager.mu.Unlock()
	if current == nil || !current.isDown() {
		return nil
	}
	// Stop the old supervisor before opening its replacement. Otherwise a retry
	// already in progress could open a second socket after this method returns and
	// displace the subscription we just installed.
	current.close()
	// Subscribe owns its socket, read loop and heartbeats through the context it
	// receives. The RPC context dies as soon as this call replies, so attaching
	// the replacement to it makes a successful reconnect immediately disconnect.
	next, err := newSignaling(manager.ctx, manager.subscribe, manager.config.Device.DeviceID, manager.receive)
	if err != nil {
		return err
	}
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		next.close()
		return errors.New("p2p.helper_unavailable")
	}
	manager.signals = next
	manager.mu.Unlock()
	return nil
}
