package main

// The daemon's reconnection loop must repair signalling, not only retry pairs.
//
// Reconnection moved into the core, and the repair that used to ride along with the
// shell's reconcile method did not come with it: the daemon drove the engine directly
// and never repaired a displaced coordinator socket. Every connect then answered
// p2p.server_unavailable while both machines still showed as online, and a restart was
// the only way out.
//
// This is asserted against the source because the loop is a goroutine inside serve(),
// which needs a listening socket, a coordinator and a restored account to run at all.
// Crude, but it pins the ordering that actually broke.

import (
	"os"
	"strings"
	"testing"
)

func TestServeRepairsSignalsBeforeReconciling(t *testing.T) {
	source, err := os.ReadFile("cli.go")
	if err != nil {
		t.Fatalf("cannot read the serve source: %v", err)
	}
	text := string(source)

	repair := strings.Index(text, "host.RepairSignals(ctx)")
	if repair < 0 {
		t.Fatal("the daemon's reconnection loop no longer repairs signalling; a displaced coordinator socket would leave every connect answering p2p.server_unavailable until restart")
	}
	reconcile := strings.Index(text, "reconnect.Reconcile(ctx)")
	if reconcile < 0 {
		t.Fatal("the daemon no longer reconciles pairs")
	}
	// Repair first: reconnecting pairs over a dead subscription accomplishes nothing.
	if repair > reconcile {
		t.Fatalf("signalling is repaired at %d, after pairs are reconciled at %d; the repair has to come first or the pass runs against a subscription that is still down", repair, reconcile)
	}
}
