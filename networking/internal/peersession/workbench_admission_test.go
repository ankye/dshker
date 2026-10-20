package peersession

import (
	"context"
	"testing"
)

func TestStaleOrInvalidTargetCannotRestoreClearedIntent(t *testing.T) {
	for _, invalid := range []string{"stale", "target"} {
		t.Run(invalid, func(t *testing.T) {
			manager, pairID, _ := intentManager(t)
			refusedConnect(t, manager, pairID, 7, true)
			_ = manager.Disconnect(pairID)
			generation, want := uint64(7), "p2p.stale_generation"
			if invalid == "target" {
				manager.config.Device.DeviceID = "ffffffffffff"
				generation, want = 8, "p2p.identity_mismatch"
			}
			if _, err := manager.Connect(context.Background(), pairID, generation, true); err == nil || err.Error() != want {
				t.Fatalf("Connect = %v, want %s", err, want)
			}
			if manager.WorkbenchRequested(pairID) {
				t.Fatal("rejected request restored cleared workbench intent")
			}
		})
	}
}

func TestAuthorizationLossAndCloseClearIntent(t *testing.T) {
	for _, operation := range []string{"pair", "network", "close"} {
		t.Run(operation, func(t *testing.T) {
			manager, pairID, _ := intentManager(t)
			refusedConnect(t, manager, pairID, 1, true)
			if !manager.WorkbenchRequested(pairID) {
				t.Fatal("admitted request did not retain intent")
			}
			switch operation {
			case "pair":
				manager.revoke(pairID)
			case "network":
				if err := manager.RevokeNetwork(manager.pins[pairID].Pair.NetworkID); err != nil {
					t.Fatal(err)
				}
			case "close":
				manager.Close()
			}
			if manager.WorkbenchRequested(pairID) || manager.workbenches[pairID] {
				t.Fatal("removed owner retained workbench intent")
			}
		})
	}
}

func TestReconnectOnlyResumesRetainedIntent(t *testing.T) {
	manager, pairID, _ := intentManager(t)
	refusedConnect(t, manager, pairID, 1, true)
	connection, err := manager.reserveCandidate(pairID, 2, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if !connection.requestWorkbench || !connection.resumeWorkbench {
		t.Fatal("automatic recovery did not retain bind-only intent")
	}
	manager.finish(pairID, connection)
	manual, err := manager.reserveCandidate(pairID, 3, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !manual.requestWorkbench || manual.resumeWorkbench {
		t.Fatal("explicit request lost its cold-start admission")
	}
	manager.finish(pairID, manual)
	_ = manager.Disconnect(pairID)
	background, err := manager.reserveCandidate(pairID, 4, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if background.requestWorkbench || background.resumeWorkbench {
		t.Fatal("background request invented workbench intent")
	}
	manager.finish(pairID, background)
}
