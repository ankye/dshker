package peersession

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestNetworkRevocationScopesPinsAndWaitsForReservedSession(t *testing.T) {
	manager, pin := pinFixture()
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	other := pin
	other.Pair.PairID = strings.Repeat("1", 32)
	other.Pair.NetworkID = strings.Repeat("2", 32)
	if err := manager.Pin(other); err != nil {
		t.Fatal(err)
	}
	connection := newSession(context.Background())
	defer connection.cancel()
	manager.sessions = map[string]*session{pin.Pair.PairID: connection}
	completed := make(chan error, 1)
	go func() { completed <- manager.RevokeNetwork(pin.Pair.NetworkID) }()
	select {
	case <-connection.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("reserved session was not cancelled")
	}
	select {
	case <-completed:
		t.Fatal("revocation acknowledged before owned cleanup")
	default:
	}
	if err := manager.Pin(pin); err == nil || err.Error() != "p2p.network_revoked" {
		t.Fatalf("old network repinned: %v", err)
	}
	reassigned := pin
	reassigned.Pair.NetworkID = other.Pair.NetworkID
	if err := manager.Pin(reassigned); err == nil {
		t.Fatal("revoked pair reused in another network")
	}
	repeated := make(chan error, 1)
	go func() { repeated <- manager.RevokeNetwork(pin.Pair.NetworkID) }()
	manager.finish(pin.Pair.PairID, connection)
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("revocation did not complete after cleanup")
	}
	select {
	case err := <-repeated:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("repeated revocation failed to settle")
	}
	if _, exists := manager.pins[pin.Pair.PairID]; exists {
		t.Fatal("revoked pin survived")
	}
	if manager.pins[other.Pair.PairID].Pair != other.Pair {
		t.Fatal("unrelated network changed")
	}
	if err := manager.RevokeNetwork(pin.Pair.NetworkID); err != nil {
		t.Fatal("repeated cleanup should be idempotent")
	}
	if err := manager.Pin(other); err != nil {
		t.Fatal("unrelated network blocked")
	}
}

func TestNetworkRevocationRejectsInvalidOrClosedManager(t *testing.T) {
	manager, pin := pinFixture()
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	if err := manager.RevokeNetwork(""); err == nil {
		t.Fatal("missing network accepted")
	}
	if len(manager.pins) != 1 {
		t.Fatal("invalid request changed authority")
	}
	manager.closed = true
	if err := manager.RevokeNetwork(pin.Pair.NetworkID); err == nil {
		t.Fatal("closed manager accepted operation")
	}
}
