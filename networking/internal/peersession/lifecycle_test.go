package peersession

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestCandidateReservationPreservesPrimaryAndRejectsOverlap(t *testing.T) {
	manager, pin := pinFixture()
	manager.ctx, manager.cancel = context.WithCancel(context.Background())
	defer manager.cancel()
	manager.config.CoreInstanceID = protocol.NewNonce()
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	primary := newSession(manager.ctx)
	primary.PairID = pin.Pair.PairID
	manager.sessions = map[string]*session{pin.Pair.PairID: primary}
	candidate, err := manager.reserveCandidate(pin.Pair.PairID, 1, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if manager.sessions[pin.Pair.PairID] != primary || primary.ctx.Err() != nil {
		t.Fatal("reservation destroyed the live primary")
	}
	if _, err := manager.reserveCandidate(pin.Pair.PairID, 2, true, true); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatalf("overlapping candidate = %v", err)
	}
	manager.finish(pin.Pair.PairID, candidate)
	if manager.sessions[pin.Pair.PairID] != primary || primary.ctx.Err() != nil {
		t.Fatal("candidate cleanup affected the primary")
	}
	manager.finish(pin.Pair.PairID, primary)
}

func TestInvalidationRejectsLateOwnerBinding(t *testing.T) {
	manager, pin := pinFixture()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	child, stop := context.WithCancel(ctx)
	defer stop()
	connection := &session{ctx: child, cancel: stop, transport: &peer.Transport{}, lease: protocol.Lease{ToDeviceID: manager.config.Device.DeviceID}}
	manager.inbound = map[string]*session{pin.Pair.PairID: connection}
	entered, release := make(chan struct{}), make(chan struct{})
	manager.owner = func(context.Context, string) (runtimebridge.Binding, error) {
		close(entered)
		<-release
		return runtimebridge.Binding{Generation: 3, URL: "http://127.0.0.1:4567/?token=secret"}, nil
	}
	result := make(chan error, 1)
	go func() {
		binding, err := manager.runtimeOwner(connection)(ctx, pin.Pair.PairID)
		if binding.URL != "" {
			t.Error("stale credential escaped")
		}
		result <- err
	}()
	<-entered
	manager.InvalidateRuntime(3)
	close(release)
	if err := <-result; err == nil || err.Error() != "p2p.runtime_invalidated" {
		t.Fatalf("late owner result accepted: %v", err)
	}
}

func TestInvalidationPreservesOtherRuntimeAndOutgoingPeer(t *testing.T) {
	manager, pin := pinFixture()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	incoming := newSession(ctx)
	incoming.transport = &peer.Transport{}
	incoming.lease.ToDeviceID = manager.config.Device.DeviceID
	incoming.result.State.RuntimeGeneration = 8
	outgoing := newSession(ctx)
	outgoing.transport = &peer.Transport{}
	outgoing.lease.ToDeviceID = pin.Target.DeviceID
	outgoing.result.State.RuntimeGeneration = 7
	// Each direction owns its slot: the answered session serves this machine's
	// runtime, the dialled one browses the far side's, and invalidation is asked
	// about the served side only.
	manager.sessions = map[string]*session{"outgoing": outgoing}
	manager.inbound = map[string]*session{"incoming": incoming}
	manager.InvalidateRuntime(7)
	if incoming.ctx.Err() != nil || outgoing.ctx.Err() != nil {
		t.Fatal("invalidation cancelled an unrelated runtime")
	}
	manager.InvalidateRuntime(8)
	if incoming.ctx.Err() == nil || outgoing.ctx.Err() != nil {
		t.Fatal("invalidation did not remain scoped to the local runtime")
	}
}
