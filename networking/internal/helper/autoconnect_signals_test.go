package helper

// Repairing the coordinator subscription on the headless path.
//
// A socket displaced by a newer process leaves the manager standing down, and every
// later connect answers p2p.server_unavailable — while both machines still report as
// online, because presence and signalling travel different paths. The shell gets the
// repair through peer.autoconnect_reconcile. A daemon drives the engine directly, so
// the repair has to be reachable without that method; these tests pin that it is, and
// that asking for it is safe in the states a daemon is actually in.

import (
	"context"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// TestRepairSignalsSkipsAccountsWithNoManager covers the daemon's ordinary startup
// state: an account is configured but not yet restored, so it has no manager. The
// ticker fires regardless, and a nil manager must not panic.
func TestRepairSignalsSkipsAccountsWithNoManager(t *testing.T) {
	host := New(context.Background())
	serviceID := protocol.NewID()
	host.accounts[serviceID] = &account{
		identity: controlplane.Identity{ServiceID: serviceID},
		host:     host,
	}
	// The absence of a panic is the assertion.
	host.RepairSignals(context.Background())
}

// TestRepairSignalsWithNoAccountsIsHarmless is the state before any account is
// configured, which is where a fresh daemon begins.
func TestRepairSignalsWithNoAccountsIsHarmless(t *testing.T) {
	host := New(context.Background())
	host.RepairSignals(context.Background())
}

// TestRepairSignalsStopsOnCancellation keeps a shutting-down daemon from working
// through a long account list instead of exiting.
func TestRepairSignalsStopsOnCancellation(t *testing.T) {
	host := New(context.Background())
	for index := 0; index < 4; index++ {
		serviceID := protocol.NewID()
		host.accounts[serviceID] = &account{
			identity: controlplane.Identity{ServiceID: serviceID},
			host:     host,
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	host.RepairSignals(ctx)
}

// TestRepairSignalsIsIdempotent matters because the daemon calls this on every pass.
// A healthy subscription must not be replaced, or two processes would kick each other
// off continuously.
func TestRepairSignalsIsIdempotent(t *testing.T) {
	host := New(context.Background())
	serviceID := protocol.NewID()
	host.accounts[serviceID] = &account{
		identity: controlplane.Identity{ServiceID: serviceID},
		host:     host,
	}
	for attempt := 0; attempt < 3; attempt++ {
		host.RepairSignals(context.Background())
	}
}
