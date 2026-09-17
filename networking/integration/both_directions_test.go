package integration

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

// Two launchers keep one pair connected from both ends at once.
//
// This is the product's real topology and it went untested: every helper dialled
// the same direction, so the suite only ever modelled one dialler and one
// answerer. Meanwhile both machines auto-connect — an active pair is an intent on
// each of them — and the coordinator admitted one attempt per pair in either
// direction. Whichever side dialled first kept the other refused with
// p2p.connection_busy, and a live session renewing its lease every 20 seconds
// meant the refusal never lapsed: two machines, both online, both authorized,
// stuck on "connecting" indefinitely.
//
// The test drives real child processes against the real coordinator binary, so it
// fails against a server that keys attempts by pair rather than by directed link.
func TestTwoPeerProcessConnectsInBothDirectionsAtOnce(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])

	// Two independent attempts, one per direction: connectBothWays fails if the
	// coordinator refuses the reverse dial or hands back the same attempt.
	connectBothWays(t, a, b, 1)

	// Each direction is a session of its own, so payloads must flow on both
	// without one displacing the other.
	data := []byte("both directions live at once over one pair")
	digest := hex.EncodeToString(func() []byte { sum := sha256.Sum256(data); return sum[:] }())
	a.call(t, command{Op: "send", Data: data, Count: 1})
	if got := waitPackets(t, b, 1).Digest; got != digest {
		t.Fatalf("outbound payload digest %s, want %s", got, digest)
	}
	b.call(t, command{Op: "send", Data: data, Count: 1})
	if got := waitPackets(t, a, 1).Digest; got != digest {
		t.Fatalf("inbound payload digest %s, want %s", got, digest)
	}

	// Both directions stay up past the original 60-second lease expiry, which only
	// happens if each is renewed independently. This is the loop that turned a
	// transient glare into a permanent refusal, so it is the loop both directions
	// have to survive.
	//
	// The renewals themselves are not asserted per direction: this test driver
	// keeps a single `lease` field per child, and each child here is the dialler of
	// one direction and the answerer of the other, so the field cannot report both.
	// Payload delivery after the expiry window is the observable that does not
	// depend on it — a lease that stopped being renewed takes its session down.
	time.Sleep(70 * time.Second)

	a.call(t, command{Op: "send", Data: data, Count: 1})
	if got := waitPackets(t, b, 2).Packets; got != 2 {
		t.Fatalf("outbound direction died after the lease expiry window: %d packets", got)
	}
	b.call(t, command{Op: "send", Data: data, Count: 1})
	if got := waitPackets(t, a, 2).Packets; got != 2 {
		t.Fatalf("inbound direction died after the lease expiry window: %d packets", got)
	}
}

// A reconnect on one direction must not disturb the other.
//
// The client abandons an attempt and ends it asynchronously, so a reconnect can
// reach the coordinator while the previous attempt is still recorded. That has to
// supersede its own link only: the reverse session belongs to the other machine's
// tab and nothing about redialling this direction concerns it.
func TestTwoPeerProcessReconnectKeepsTheReverseDirection(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])
	_, inbound := connectBothWays(t, a, b, 1)

	// Redial a→b with a newer generation; b→a keeps running underneath.
	reconnected := connect(t, a, b, 2)
	if reconnected == inbound {
		t.Fatal("the reconnect took over the reverse direction's attempt")
	}

	data := []byte("the reverse direction survived a redial of the other one")
	digest := hex.EncodeToString(func() []byte { sum := sha256.Sum256(data); return sum[:] }())
	b.call(t, command{Op: "send", Data: data, Count: 1})
	if got := waitPackets(t, a, 1).Digest; got != digest {
		t.Fatalf("reverse direction digest %s, want %s", got, digest)
	}
}
