//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// These exercise only test-helper admission, with the existing D24 pure wire.
// No credential provider, coordinator, socket, core or DSH is started here.
func TestCoreReadyGenerationRequiresExactCompletedOwner(t *testing.T) {
	for _, name := range []string{"valid", "pair", "attempt", "zero", "punching", "connected", "refusal", "runtime", "runtime-overflow", "overflow", "wrapped"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			state := wire.owner.current
			state.Stage, state.RuntimeGeneration = "ready", 2
			switch name {
			case "pair":
				state.PairID = protocol.NewID()
			case "attempt":
				state.AttemptID = ""
			case "zero":
				state.Generation = 0
			case "punching", "connected":
				state.Stage = name
			case "refusal":
				state.Error = "runtime.worktree_invalid"
			case "runtime":
				state.RuntimeGeneration = 0
			case "runtime-overflow":
				state.RuntimeGeneration = 1 << 53
			case "overflow":
				state.Generation = 1<<53 - 1
			case "wrapped":
				state.Generation = ^uint64(0)
			}
			generation, err := coreReadySuccessorGeneration(state, wire.owner.pair)
			if name == "valid" {
				if err != nil || generation != state.Generation+1 {
					t.Fatal("successor did not derive from the exact completed ready owner", generation, err)
				}
			} else if generation != 0 || err == nil || err.Error() != "test.ready_generation_invalid" {
				t.Fatal("unfinished, foreign or overflowing owner granted a generation", generation, err)
			}
		})
	}
}

func TestCoreAutomaticWorkbenchOutcomeWaitsWithoutConnectingOrMinting(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		wire := recoveryBootstrapTestWire(t)
		prior := wire.owner.current
		type result struct {
			state peersession.State
			err   error
		}
		done := make(chan result, 1)
		go func() {
			state, err := coreWaitWorkbenchOutcome(wire.f.ctx, wire.owner.peer, wire.call, wire.f, wire.owner, prior.Generation, "ready", "", 2)
			done <- result{state, err}
		}()
		synctest.Wait()
		candidate := peersession.State{PairID: prior.PairID, AttemptID: protocol.NewNonce(), Generation: prior.Generation + 1, Stage: "punching"}
		for _, stage := range []string{"punching", "starting-runtime", "connected"} {
			candidate.Stage = stage
			if stage == "connected" {
				candidate.Error = "runtime.worktree_invalid"
			}
			wire.owner.observe(candidate)
			synctest.Wait()
			select {
			case <-done:
				t.Fatal("unfinished or refused automatic owner was accepted as a recovered workbench")
			default:
			}
		}
		completed := peersession.State{PairID: prior.PairID, AttemptID: protocol.NewNonce(), Generation: prior.Generation + 2, Stage: "ready", RuntimeGeneration: 2}
		wire.owner.observe(completed)
		actual := <-done
		if actual.err != nil || actual.state != completed || !reflect.DeepEqual(wire.methods, []string{"core.catalog_inspect"}) {
			t.Fatal("automatic wait dialed, minted or lost its exact completed owner", actual.state, wire.methods, actual.err)
		}
	})
}

func TestCoreAutomaticWorkbenchOutcomeRejectsForeignFailedAndChangedOwner(t *testing.T) {
	for _, name := range []string{"peer", "pair", "late", "failed", "disconnected", "catalog", "replacement", "detached-during-read"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			prior := wire.owner.current
			completed := peersession.State{PairID: prior.PairID, AttemptID: protocol.NewNonce(), Generation: prior.Generation + 1, Stage: "ready", RuntimeGeneration: 2}
			wire.owner.observe(completed)
			peer := wire.owner.peer
			switch name {
			case "peer":
				peer = new(localrpc.Peer)
			case "pair":
				completed.PairID = protocol.NewID()
				wire.owner.observe(completed)
			case "late":
				wire.owner.observe(prior)
			case "failed", "disconnected":
				completed.Stage = name
				completed.Error = "p2p.connection_busy"
				wire.owner.observe(completed)
			case "catalog":
				wire.view.Record.Computers = nil
			case "replacement":
				wire.hook = func(string, *recoveryBootstrapWire) {
					replacement := completed
					replacement.Generation++
					replacement.AttemptID = protocol.NewNonce()
					wire.owner.observe(replacement)
				}
			case "detached-during-read":
				wire.hook = func(string, *recoveryBootstrapWire) { wire.owner.peer = new(localrpc.Peer) }
			}
			_, err := coreWaitWorkbenchOutcome(wire.f.ctx, peer, wire.call, wire.f, wire.owner, prior.Generation, "ready", "", 2)
			if err == nil || !strings.HasPrefix(err.Error(), "test.") {
				t.Fatal("foreign, failed or changed owner was hidden or retried", err)
			}
			for _, method := range wire.methods {
				if method != "core.catalog_inspect" {
					t.Fatal("failed observation changed core state", wire.methods)
				}
			}
		})
	}
}

func TestCoreAutomaticWorkbenchRefusalKeepsCompletedOutcomeWhileAutoContinues(t *testing.T) {
	for _, stage := range []string{"connected", "ready"} {
		t.Run(stage, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			prior := wire.owner.current
			completed := peersession.State{PairID: prior.PairID, AttemptID: protocol.NewNonce(), Generation: prior.Generation + 1, Stage: "connected", Error: "p2p.runtime_invalid"}
			wire.owner.observe(completed)
			wire.hook = func(string, *recoveryBootstrapWire) {
				successor := peersession.State{PairID: prior.PairID, AttemptID: protocol.NewNonce(), Generation: completed.Generation + 1, Stage: stage, Error: "runtime.worktree_invalid"}
				if stage == "ready" {
					successor.Error, successor.RuntimeGeneration = "", 2
				}
				wire.owner.observe(successor)
			}
			actual, err := coreWaitWorkbenchOutcome(context.Background(), wire.owner.peer, wire.call, wire.f, wire.owner, prior.Generation, "connected", "p2p.runtime_invalid", 0)
			if err != nil || actual != completed || wire.owner.current.Stage != stage || wire.owner.current.Generation <= completed.Generation {
				t.Fatal("continued automatic intent erased a completed typed refusal", actual, err)
			}
			call := coreHistoricalEntryTestCall(t, wire, completed, errors.New("p2p.stale_generation"))
			must(t, coreReadRefusedHistoricalEntry(context.Background(), call, wire.f.authority.ServiceID, prior.PairID, peersession.Connected{State: actual}))
			if !reflect.DeepEqual(wire.methods, []string{"core.catalog_inspect", "peer.entry"}) {
				t.Fatal("historical refusal readback retried Connect or skipped exact entry", wire.methods)
			}
		})
	}
}

func coreHistoricalEntryTestCall(t *testing.T, wire *recoveryBootstrapWire, historical peersession.State, refusal error) recoveryCoreCall {
	t.Helper()
	return func(_ context.Context, method string, payload any) (json.RawMessage, error) {
		wire.methods = append(wire.methods, method)
		data, err := json.Marshal(payload)
		must(t, err)
		var request struct {
			ServiceID string `json:"serviceId"`
			Data      struct {
				PairID     string `json:"pairId"`
				Generation uint64 `json:"generation"`
			} `json:"data"`
		}
		if method != "peer.entry" || protocol.DecodeExact(data, &request) != nil || request.ServiceID != wire.f.authority.ServiceID || request.Data.PairID != historical.PairID || request.Data.Generation != historical.Generation {
			t.Fatalf("historical readback changed operation or exact service/pair/generation: %s %s", method, data)
		}
		return nil, refusal
	}
}

func TestCoreRefusedEntryReadbackRequiresHistoricalScopeAndStrictRefusal(t *testing.T) {
	for _, name := range []string{"not-connected", "stale", "success", "busy", "not-found", "service", "pair", "attempt", "generation", "stage", "missing-refusal", "untyped-refusal", "wrapped-refusal", "runtime", "url"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			state := wire.owner.current
			state.Error = "runtime.worktree_invalid"
			connected := peersession.Connected{State: state}
			serviceID, pairID := wire.f.authority.ServiceID, state.PairID
			entryErr := errors.New("p2p.not_connected")
			switch name {
			case "stale":
				entryErr = errors.New("p2p.stale_generation")
			case "success":
				entryErr = nil
			case "busy":
				entryErr = errors.New("p2p.connection_busy")
			case "not-found":
				entryErr = errors.New("p2p.connection_not_found")
			case "service":
				serviceID = ""
			case "pair":
				pairID = protocol.NewID()
			case "attempt":
				connected.State.AttemptID = ""
			case "generation":
				connected.State.Generation = 0
			case "stage":
				connected.State.Stage = "ready"
			case "missing-refusal":
				connected.State.Error = ""
			case "untyped-refusal":
				connected.State.Error = "owner is unavailable"
			case "wrapped-refusal":
				connected.State.Error = "runtime.worktree_invalid: detail"
			case "runtime":
				connected.State.RuntimeGeneration = 1
			case "url":
				connected.URL = "http://127.0.0.1:34567/"
			}
			validScope := name == "not-connected" || name == "stale" || name == "success" || name == "busy" || name == "not-found"
			err := coreReadRefusedHistoricalEntry(context.Background(), coreHistoricalEntryTestCall(t, wire, state, entryErr), serviceID, pairID, connected)
			wantPass := name == "not-connected" || name == "stale"
			if wantPass && err != nil || !wantPass && err == nil || validScope && !reflect.DeepEqual(wire.methods, []string{"peer.entry"}) || !validScope && len(wire.methods) != 0 {
				t.Fatal("historical scope, strict refusal or read-only exact entry admission changed", wire.methods, err)
			}
		})
	}
}
