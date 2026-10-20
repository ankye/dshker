package peersession

import (
	"context"
	"net/http"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func leaseFor(from, to string) protocol.Lease {
	return protocol.Lease{FromDeviceID: from, ToDeviceID: to}
}

// v2 admission reserves independent directed candidates without displacing
// either primary. Legacy Begin/start is not a production Manager entry point.
func TestBothDirectionsHoldTheirOwnSlot(t *testing.T) {
	manager, fence, key := controlCandidateManager(t, http.NotFoundHandler())
	_, pin := pinFixture()
	pairID := pin.Pair.PairID
	local, remote := manager.config.Device.DeviceID, pin.Target.DeviceID
	primary := newSession(manager.ctx)
	primary.PairID, primary.lease = pairID, leaseFor(local, remote)
	answered := newSession(manager.ctx)
	answered.PairID, answered.lease = pairID, leaseFor(remote, local)
	manager.sessions[pairID], manager.inbound[pairID] = primary, answered
	outbound, err := manager.reserveCandidate(pairID, 1, false, false)
	if err != nil {
		t.Fatal(err)
	}
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(), UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: local, Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	ticket := signedCandidate(request, remote, protocol.NewNonce(), key)
	inbound, err := manager.reserveInboundCandidate(ticket)
	if err != nil {
		t.Fatal(err)
	}
	if manager.sessions[pairID] != primary || manager.inbound[pairID] != answered || manager.candidates[pairID] != outbound || manager.inboundCandidates[pairID] != inbound {
		t.Fatal("candidate admission displaced a primary or the opposite direction")
	}
	if _, err := manager.reserveInboundCandidate(ticket); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("duplicate inbound candidate admitted", err)
	}
	if _, err := manager.reserveCandidate(pairID, 2, false, false); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatal("overlapping outbound candidate admitted", err)
	}
	manager.finish(pairID, inbound)
	manager.finish(pairID, outbound)
	if manager.sessions[pairID] != primary || manager.inbound[pairID] != answered {
		t.Fatal("candidate cleanup retired a primary")
	}
	delete(manager.pins, pairID)
	if _, err := manager.reserveInboundCandidate(ticket); err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatal("unpinned inbound candidate admitted", err)
	}
}

// Retiring one direction leaves the other exactly where it was, and revocation
// ends whichever sessions remain.
func TestRetiringOneDirectionLeavesTheOther(t *testing.T) {
	manager, pin := pinFixture()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.ctx = ctx
	pairID := pin.Pair.PairID
	dialed := newSession(ctx)
	dialed.lease = leaseFor(manager.config.Device.DeviceID, pin.Target.DeviceID)
	answered := newSession(ctx)
	answered.lease = leaseFor(pin.Target.DeviceID, manager.config.Device.DeviceID)
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

	// Revocation ends whichever sessions remain, in either direction. The map
	// entries themselves are retired by each session's own finish, which the
	// runners reach as they unwind; the cancellation is the revocation's part.
	manager.revoke(pairID)
	if dialed.ctx.Err() == nil {
		t.Fatal("revoke left the dialled session alive")
	}
}
