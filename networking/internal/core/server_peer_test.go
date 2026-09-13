package core

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

// fakePeer stands in for the installed-peer host: it records what reached it and
// answers with its own vocabulary, including a method the published table does
// not list yet.
type fakePeer struct {
	handled []string
}

func (peer *fakePeer) Handle(_ context.Context, method string, _ json.RawMessage) (any, error) {
	peer.handled = append(peer.handled, method)
	if method == "device.createKey" {
		return struct {
			CSR string `json:"csr"`
		}{CSR: "csr"}, nil
	}
	return nil, errors.New("p2p.service_unconfigured")
}

// TestHandleRoutesThePeerHalfOfTheTable is the composition contract: the core
// owns the core.* methods, the peer host owns every other shell-role method, and
// neither can see the other's traffic.
func TestHandleRoutesThePeerHalfOfTheTable(t *testing.T) {
	peer := &fakePeer{}
	server := Serve{Peer: peer}
	ctx := context.Background()

	if _, err := server.Handle(ctx, "devices.list", json.RawMessage(`{"serviceId":"a","data":{}}`)); err == nil || err.Error() != "p2p.service_unconfigured" {
		t.Fatalf("devices.list = %v", err)
	}
	result, err := server.Handle(ctx, "device.createKey", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("device.createKey = %v", err)
	}
	if result == nil {
		t.Fatal("device.createKey returned nothing")
	}
	// A method that is not in the published table never reaches the host, so an
	// unknown name and a malformed payload cannot be confused.
	if _, err := server.Handle(ctx, "nope.nope", json.RawMessage(`{}`)); err == nil || err.Error() != "p2p.invalid_operation" {
		t.Fatalf("nope.nope = %v", err)
	}
	if len(peer.handled) != 2 {
		t.Fatalf("peer handled %v", peer.handled)
	}
	// The core's own methods never cross over.
	if _, err := server.Handle(ctx, "core.version", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("core.version = %v", err)
	}
	if len(peer.handled) != 2 {
		t.Fatalf("core.version reached the peer host: %v", peer.handled)
	}
}

// TestHandleRefusesInboundCallbacks pins the direction of the parent-role
// methods: they are calls the core makes, so one arriving is refused and is
// never handed to the peer host.
func TestHandleRefusesInboundCallbacks(t *testing.T) {
	peer := &fakePeer{}
	server := Serve{Peer: peer}
	for _, method := range []string{"runtime.connect", "peer.state"} {
		if _, err := server.Handle(context.Background(), method, json.RawMessage(`{}`)); err == nil || err.Error() != "p2p.invalid_operation" {
			t.Errorf("Handle(%q) = %v, want p2p.invalid_operation", method, err)
		}
	}
	if len(peer.handled) != 0 {
		t.Fatalf("a callback reached the peer host: %v", peer.handled)
	}
}

// TestVersionReportsTheComposedTable keeps core.version honest: the shell can
// tell a core that answers the whole table from one that only owns its stores.
func TestVersionReportsTheComposedTable(t *testing.T) {
	alone := Serve{}.MethodTable()
	composed := Serve{Peer: &fakePeer{}}.MethodTable()
	if len(composed) != len(alone)+countPeerHalf() {
		t.Fatalf("composed table has %d methods, alone has %d", len(composed), len(alone))
	}
	seen := map[string]bool{}
	for _, name := range alone {
		seen[name] = true
	}
	for _, name := range composed {
		entry, published := localrpc.Lookup(name)
		if !published || entry.Role != localrpc.RoleShell {
			t.Fatalf("composed table lists %q, which the shell table does not", name)
		}
	}
	for _, name := range alone {
		if !contains(composed, name) {
			t.Fatalf("composed table dropped %q", name)
		}
		if !seen[name] {
			t.Fatalf("alone table lost %q", name)
		}
	}

	// The composed answer is what the daemon reports on the wire.
	result, err := Serve{Peer: &fakePeer{}}.Handle(context.Background(), "core.version", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("core.version: %v", err)
	}
	version, ok := result.(versionResult)
	if !ok {
		t.Fatalf("core.version returned %T", result)
	}
	if len(version.Methods) != len(composed) || !contains(version.Methods, "peer.connect") {
		t.Fatalf("version methods %v", version.Methods)
	}
}

// countPeerHalf is the number of published shell-role methods the core does not
// answer itself.
func countPeerHalf() int {
	total := 0
	for _, method := range localrpc.Methods {
		if method.Role == localrpc.RoleShell && !served[method.Name] {
			total++
		}
	}
	return total
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
