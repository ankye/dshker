package peersession

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// leaseFor builds the lease shape `start` inspects for one direction. The
// signature is never valid here: these tests assert the admission decision
// `start` makes *before* it builds a transport, so an admitted attempt is
// expected to fail immediately afterwards at transport construction.
func leaseFor(from, to string) protocol.Lease {
	return protocol.Lease{FromDeviceID: from, ToDeviceID: to}
}

// admissionFixture is a manager whose slots are empty and whose relay lookup is
// already resolved, so `start` reaches its admission decision without a
// coordinator. A failed relay fetch is a supported state — it simply leaves the
// session on the direct path — so pre-seeding it as failed exercises the real
// code path rather than stubbing it out.
func admissionFixture(t *testing.T, ctx context.Context) (*Manager, controlplane.PairIdentity) {
	t.Helper()
	manager, pin := pinFixture()
	manager.ctx = ctx
	manager.sessions = map[string]*session{}
	manager.inbound = map[string]*session{}
	manager.turnCreds = controlplane.TurnCredentials{
		URLs:       []string{"turn:127.0.0.1:3478"},
		Username:   fmt.Sprintf("%d:%s", time.Now().Add(time.Hour).Unix(), manager.config.Device.DeviceID),
		Credential: "admission-test-credential",
	}
	manager.turnExpiresAt = time.Now().Add(time.Hour)
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	return manager, pin
}

// admitted reports whether `start` accepted the attempt into a slot.
//
// Admission and connection are separate steps. With no STUN address configured
// the transport always refuses with p2p.explicit_stun_required, so that refusal
// means the attempt passed admission, while p2p.connection_busy or
// p2p.pair_unauthorized means it was turned away before that point.
// Distinguishing the two is what lets these tests exercise the real lock and the
// real slot maps rather than asserting over maps the test populated itself.
func admitted(t *testing.T, manager *Manager, pairID string, lease protocol.Lease, reserved *session) bool {
	t.Helper()
	if _, err := manager.start(pairID, lease, reserved); err != nil {
		switch err.Error() {
		case "p2p.explicit_stun_required":
			return true
		case "p2p.connection_busy", "p2p.pair_unauthorized", "p2p.connection_cancelled", "p2p.identity_mismatch":
			return false
		default:
			t.Fatalf("unexpected refusal from start: %v", err)
		}
	}
	t.Fatal("start built a transport without a STUN address")
	return false
}

// A pair carries one session in each direction at once: this machine's own Run
// tab dials out, and the far machine's tab is the answered session here.
//
// The two shared one slot before, so whichever side dialled first kept the other
// side's connect answering p2p.connection_busy for as long as its session lived,
// with a tab that showed the answered session's stage and no address of its own
// to load.
//
// This drives `start` rather than assigning the slot maps directly. The previous
// version of this test described exactly the bug above and then verified nothing
// about it: it wrote `manager.sessions` and `manager.inbound` by hand and asserted
// over its own writes, so the admission rule it claimed to cover never ran. The
// coordinator enforced that rule per pair instead of per direction and stayed
// broken underneath this passing test.
func TestBothDirectionsHoldTheirOwnSlot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager, pin := admissionFixture(t, ctx)
	pairID := pin.Pair.PairID
	local, remote := manager.config.Device.DeviceID, pin.Target.DeviceID

	// An answered attempt is admitted into the inbound slot on an idle pair.
	if !admitted(t, manager, pairID, leaseFor(remote, local), nil) {
		t.Fatal("an answered attempt was refused on an idle pair")
	}

	// The dialled direction reserves the outbound slot in Connect, and an answered
	// attempt arriving while it lives is the normal state of two machines keeping
	// one pair connected — not a refusal. This is what the shipped coordinator got
	// wrong for the same pair.
	reserved := newSession(ctx)
	manager.sessions[pairID] = reserved
	if !admitted(t, manager, pairID, leaseFor(local, remote), reserved) {
		t.Fatal("the dialled direction was refused while holding its own slot")
	}
	manager.sessions[pairID] = reserved
	if !admitted(t, manager, pairID, leaseFor(remote, local), nil) {
		t.Fatal("an answered attempt was refused while a dialled session lived")
	}

	// A reservation that is not the recorded outbound session is stale; admitting
	// it would let it displace the live one.
	manager.sessions[pairID] = reserved
	if admitted(t, manager, pairID, leaseFor(local, remote), newSession(ctx)) {
		t.Fatal("a stale reservation was admitted over the live outbound session")
	}

	// A cancelled reservation is refused rather than connected.
	cancelled := newSession(ctx)
	cancelled.cancel()
	manager.sessions[pairID] = cancelled
	if admitted(t, manager, pairID, leaseFor(local, remote), cancelled) {
		t.Fatal("a cancelled reservation was admitted")
	}

	// An answered attempt must come from the pinned peer, not from this device.
	delete(manager.sessions, pairID)
	if admitted(t, manager, pairID, leaseFor(local, remote), nil) {
		t.Fatal("an answered attempt claiming to come from the local device was admitted")
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
