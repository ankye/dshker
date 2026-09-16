package peersession

import (
	"context"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// A pair carries one session in each direction at once: this machine's own Run
// tab dials out, and the far machine's tab is the answered session here. The
// two shared one slot before, so whichever side dialled first kept the other
// side's connect answering p2p.connection_busy for as long as its session
// lived, with a tab that showed the answered session's stage and no address of
// its own to load.
func TestBothDirectionsHoldTheirOwnSlot(t *testing.T) {
	manager, pin := pinFixture()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pairID := pin.Pair.PairID
	dialed := newSession(ctx)
	dialed.lease = protocol.Lease{FromDeviceID: manager.config.Device.DeviceID, ToDeviceID: pin.Target.DeviceID}
	answered := newSession(ctx)
	answered.lease = protocol.Lease{FromDeviceID: pin.Target.DeviceID, ToDeviceID: manager.config.Device.DeviceID}
	manager.sessions = map[string]*session{pairID: dialed}
	manager.inbound = map[string]*session{pairID: answered}

	// Retiring the answered session leaves the dialled one exactly where it was.
	manager.finish(pairID, answered)
	if manager.sessions[pairID] != dialed {
		t.Fatal("retiring the answered session dropped the dialled one")
	}
	if _, exists := manager.inbound[pairID]; exists {
		t.Fatal("the answered session was not retired")
	}

	// An answered attempt arriving while a dialled session lives is the normal
	// state of two machines keeping one pair connected, and start admits it into
	// the inbound slot rather than refusing it as busy — the refusal is what a
	// dialled-first pair used to answer the far side with forever.
	if _, busy := manager.inbound[pairID]; busy {
		t.Fatal("the inbound slot is still held after the session was retired")
	}

	// Revocation ends whichever sessions remain, in either direction. The map
	// entries themselves are retired by each session's own finish, which the
	// runners reach as they unwind; the cancellation is the revocation's part.
	manager.revoke(pairID)
	if dialed.ctx.Err() == nil {
		t.Fatal("revoke left the dialled session alive")
	}
}
