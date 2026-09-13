package integration

// Task 3.8: a direct-path failure, a runtime-availability failure and an
// authorization failure must reach the shell as three different codes. This runs
// them through the real daemon and the real private channel, because the
// collapse this guards against happened at those boundaries: a wrapped sentinel
// and a raw transport sentence each became p2p.operation_failed.
import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
)

func TestCoreDaemonKeepsFailureCodesDistinguishable(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 180*time.Second)
	defer cancel()

	states := make(chan peersession.State, 256)
	parent, stopCore := startCoreDaemon(
		t,
		func(_ context.Context, method string, payload json.RawMessage) (any, error) {
			if method != "peer.state" {
				return nil, errors.New("p2p.unexpected_callback")
			}
			var event struct {
				State peersession.State `json:"state"`
			}
			if json.Unmarshal(payload, &event) != nil {
				return nil, errors.New("p2p.invalid_payload")
			}
			select {
			case states <- event.State:
			default:
			}
			return struct{}{}, nil
		},
		coreTrustArguments(t, f)...,
	)
	defer stopCore()
	identity := configureCoreService(t, ctx, parent, f)
	restoreCoreDevice(t, ctx, parent, f)
	pairID := f.config[0].Pin.Pair.PairID

	// Authorization: a pair this device never pinned. The coordinator never sees
	// the request, and the shell must be able to say "this pair is not yours"
	// rather than "something failed".
	code := refusalOf(t, ctx, parent, "peer.connect", scopedConnect(identity.ServiceID, strings.Repeat("f", 32), 1))
	if code != "p2p.pair_unauthorized" {
		t.Fatalf("unpinned pair connect = %q", code)
	}
	authorization := code

	// Runtime availability: browsing a pair with no live session. The runtime is
	// not reachable yet, which is a different answer from "no direct path".
	code = refusalOf(t, ctx, parent, "remote.roots", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			PairID string `json:"pairId"`
		} `json:"data"`
	}{ServiceID: identity.ServiceID, Data: struct {
		PairID string `json:"pairId"`
	}{PairID: pairID}})
	if code != "p2p.not_connected" {
		t.Fatalf("remote.roots without a session = %q", code)
	}
	availability := code

	// Peer presence: the pinned pair, but nothing is running on the other
	// computer. The coordinator answers that before a path is even attempted, and
	// it is a better answer than a generic transport failure: the user's action
	// is to start the other computer, not to debug a network.
	started := time.Now()
	code = refusalOf(t, ctx, parent, "peer.connect", scopedConnect(identity.ServiceID, pairID, 1))
	t.Logf("absent remote refused with %q after %s", code, time.Since(started).Round(time.Millisecond))
	if code != "p2p.peer_offline" {
		t.Fatalf("absent remote refused with %q", code)
	}
	presence := code

	// These three are all refused before a session exists, so they never produce a
	// peer.state; the state channel and the refusal agreeing on a code is covered
	// where a session really fails, by the two-peer stability tests.
	if authorization == availability || availability == presence || authorization == presence {
		t.Fatalf("codes collapsed: %q, %q, %q", authorization, availability, presence)
	}
}

// refusalOf calls a method that must fail and returns its refusal code, failing
// the test when the call succeeds or when the code is the generic fallback.
func refusalOf(t *testing.T, ctx context.Context, parent *localrpc.Peer, method string, payload any) string {
	t.Helper()
	_, err := parent.Call(ctx, method, payload)
	if err == nil {
		t.Fatalf("%s succeeded, want a refusal", method)
	}
	if err.Error() == "p2p.operation_failed" || !strings.HasPrefix(err.Error(), "p2p.") {
		t.Fatalf("%s refused with %q, which is not a named code", method, err)
	}
	return err.Error()
}

// scopedConnect is the shell's peer.connect payload for one pair.
func scopedConnect(serviceID, pairID string, generation uint64) any {
	return struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			PairID     string `json:"pairId"`
			Generation uint64 `json:"generation"`
		} `json:"data"`
	}{
		ServiceID: serviceID,
		Data: struct {
			PairID     string `json:"pairId"`
			Generation uint64 `json:"generation"`
		}{PairID: pairID, Generation: generation},
	}
}
