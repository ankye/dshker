package integration

// Task 5.1: the SSH route belongs to the core. This drives the real daemon over
// the real private channel and asserts the codes the renderer already maps; a
// full route needs two machines and is covered where the two machines are.
import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestCoreDaemonOwnsTheRemoteRoute(t *testing.T) {
	parent, stopCore := startCoreDaemon(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_callback")
	})
	defer stopCore()
	ctx := context.Background()

	// A connection that was never opened reports nothing rather than failing.
	status, err := parent.Call(ctx, "remote.status", json.RawMessage(`{"connectionId":"connection_absent"}`))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	var view struct {
		Present bool `json:"present"`
	}
	if json.Unmarshal(status, &view) != nil || view.Present {
		t.Fatalf("status = %s", status)
	}

	// Disconnecting one is refused by name.
	if _, err := parent.Call(ctx, "remote.disconnect", json.RawMessage(`{"connectionId":"connection_absent"}`)); err == nil || err.Error() != "remote.connection_not_found" {
		t.Fatalf("disconnect = %v", err)
	}

	// A missing OpenSSH client is its own code, not a generic failure. The route
	// resolves the platform pair itself, so the test names a path that cannot
	// work rather than pretending a machine is reachable.
	request := json.RawMessage(`{"connectionId":"connection_main","computer":{"host":"127.0.0.1","port":1,"user":"nobody"},"ssh":"/nonexistent/ssh","scp":"/nonexistent/scp"}`)
	if _, err := parent.Call(ctx, "remote.connect", request); err == nil || err.Error() != "remote.ssh_unavailable" {
		t.Fatalf("connect = %v", err)
	}
}
