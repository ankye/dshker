package peer

import (
	"time"

	"github.com/pion/webrtc/v4"
)

// LiveState is a current transport fact, not the once-closed establishment ready
// channel. Window fences callbacks belonging to an earlier disconnect interval.
type LiveState struct {
	Ready     bool
	Suspended bool
	Window    uint64
}

func (transport *Transport) LiveState() LiveState {
	transport.mu.Lock()
	state := LiveState{Suspended: transport.graceTimer != nil, Window: transport.graceWindow}
	validLease := transport.lease.ExpiresAt > time.Now().Unix()
	transport.mu.Unlock()
	if transport.ctx == nil || transport.ctx.Err() != nil || transport.pc == nil || transport.channel == nil || !validLease {
		return state
	}
	select {
	case <-transport.ready:
	default:
		return state
	}
	ice := transport.pc.ICEConnectionState()
	state.Ready = !state.Suspended && transport.pc.ConnectionState() == webrtc.PeerConnectionStateConnected &&
		(ice == webrtc.ICEConnectionStateConnected || ice == webrtc.ICEConnectionStateCompleted) &&
		transport.channel.ReadyState() == webrtc.DataChannelStateOpen
	return state
}

// Changes is coalesced: consumers re-read LiveState after each notification.
// Pion callbacks only publish this bounded notification; no network work runs in
// a callback and a full notification queue cannot block a transport.
func (transport *Transport) Changes() <-chan struct{} { return transport.lifecycle }

func (transport *Transport) changed() {
	select {
	case transport.lifecycle <- struct{}{}:
	default:
	}
}
