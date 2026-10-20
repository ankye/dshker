package integration

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestHostColdObserverRejectsForeignScopeStaleAndAliasedAttempts(t *testing.T) {
	for _, kind := range []string{"service", "direction", "stale-generation", "aliased-attempt", "overflow"} {
		t.Run(kind, func(t *testing.T) {
			owner := &hostColdOwner{serviceID: protocol.NewID(), pairID: protocol.NewID(), receipts: make(chan peersession.State, 1)}
			current := peersession.State{PairID: owner.pairID, AttemptID: protocol.NewNonce(), Generation: 10, Stage: "connected"}
			if err := owner.recordState(owner.serviceID, current); err != nil {
				t.Fatal(err)
			}
			next, serviceID := current, owner.serviceID
			switch kind {
			case "service":
				serviceID = protocol.NewID()
			case "direction":
				next.PairID = protocol.NewID()
			case "stale-generation":
				next.Generation--
			case "aliased-attempt":
				next.AttemptID = protocol.NewNonce()
			}
			if err := owner.recordState(serviceID, next); err == nil {
				t.Fatal("observer accepted a foreign stale aliased or dropped receipt", kind)
			}
			observed, err := owner.snapshot()
			if err == nil || observed != current {
				t.Fatal("invalid callback changed the observer's current outbound identity", kind)
			}
		})
	}
}

func TestHostColdObserverDoesNotUseBufferedConnectedAfterSuspensionOrDeadline(t *testing.T) {
	var owners [2]*hostColdOwner
	for index := range owners {
		owners[index] = &hostColdOwner{serviceID: protocol.NewID(), pairID: protocol.NewID(), receipts: make(chan peersession.State, 4)}
		state := peersession.State{PairID: owners[index].pairID, AttemptID: protocol.NewNonce(), Generation: 10, Stage: "connected"}
		if err := owners[index].recordState(owners[index].serviceID, state); err != nil {
			t.Fatal(err)
		}
	}
	suspended, _ := owners[0].snapshot()
	suspended.Stage = "suspended"
	if err := owners[0].recordState(owners[0].serviceID, suspended); err != nil {
		t.Fatal(err)
	}
	latest, err := owners[0].snapshot()
	if err != nil || hostColdTransportReady(latest) {
		t.Fatal("buffered old connected was treated as current transport readiness")
	}
	latest.Stage = "connected"
	if err := owners[0].recordState(owners[0].serviceID, latest); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Millisecond))
	defer cancel()
	if _, err := hostColdObserveTransport(ctx, owners); err == nil {
		t.Fatal("buffered success crossed the original cold deadline")
	}
	latest.RuntimeGeneration = 1
	if hostColdTransportReady(latest) {
		t.Fatal("runtime-ready state was relabeled transport-only cold bootstrap")
	}
}
