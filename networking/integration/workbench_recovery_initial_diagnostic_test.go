//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

const recoveryInitialDiagnosticBudget = 10 * time.Second

type recoveryInitialFailure struct {
	Phase string
	cause error
}

func (failure recoveryInitialFailure) Error() string {
	return "test.initial_setup_failed phase=" + failure.Phase + " cause=" + recoveryInitialDiagnosticCode(failure.cause)
}

func (failure recoveryInitialFailure) Unwrap() error { return failure.cause }

func recoveryInitialDiagnosticCode(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "context.deadline_exceeded"
	case errors.Is(err, context.Canceled):
		return "context.canceled"
	case err == nil:
		return "unknown_fatal"
	default:
		if code, ok := protocol.Refusal(err); ok {
			switch code {
			case "p2p.rate_limited", "p2p.server_unavailable", "p2p.signalling_not_ready", "p2p.registration_stale",
				"p2p.stale_generation", "p2p.connection_busy", "p2p.candidate_expired", "p2p.candidate_cancelled",
				"p2p.peer_offline", "p2p.pair_unauthorized", "p2p.not_connected", "p2p.runtime_unavailable":
				return code
			}
		}
		// Do not serialize an RPC/HTTP error sentence or a caller-supplied code.
		return "unknown"
	}
}

type recoveryInitialTrace struct {
	phase    string
	err      error
	accepted bool
}

func (trace *recoveryInitialTrace) call(call recoveryCoreCall) recoveryCoreCall {
	return func(ctx context.Context, method string, payload any) (json.RawMessage, error) {
		switch method {
		case "core.catalog_inspect":
			trace.phase = "initial_catalog"
		case "peer.connect":
			trace.phase = "initial_business_open"
		case "peer.entry":
			trace.phase = "initial_entry"
		}
		return call(ctx, method, payload)
	}
}

func (trace *recoveryInitialTrace) reverse(reverse func() error) func() error {
	if reverse == nil {
		return nil
	}
	return func() error {
		trace.phase = "initial_reverse_open"
		return reverse()
	}
}

// Only an already failed acceptance can schedule observation. This never calls
// the existing 45s post-recovery observer or uses the expired acceptance ctx.
func (trace *recoveryInitialTrace) diagnose(failed bool, seal func(recoveryInitialFailure), observe func(context.Context)) bool {
	if !failed || trace.accepted {
		return false
	}
	failure := recoveryInitialFailure{Phase: trace.phase, cause: trace.err}
	seal(failure)
	ctx, cancel := context.WithTimeout(context.Background(), recoveryInitialDiagnosticBudget)
	defer cancel()
	observe(ctx)
	return true
}

func recoveryInitialDiagnosticScope(service, pair string, core *localrpc.Peer, owner *recoveryBootstrapOwner) recoveryDiagnosticScope {
	scope := recoveryDiagnosticScope{ServiceID: service, PairID: pair}
	if core == nil || owner == nil {
		return scope
	}
	owner.mu.Lock()
	defer owner.mu.Unlock()
	state := owner.current
	if owner.peer == core && owner.pair == pair && owner.err == nil && state.PairID == pair &&
		protocol.ValidNonce(state.AttemptID) && protocol.ValidGeneration(state.Generation) {
		scope.AttemptID, scope.Generation = state.AttemptID, state.Generation
	}
	return scope
}

func recoveryDiagnosticExact(scope recoveryDiagnosticScope) bool {
	return protocol.ValidID(scope.ServiceID) && protocol.ValidID(scope.PairID) &&
		protocol.ValidNonce(scope.AttemptID) && protocol.ValidGeneration(scope.Generation)
}

type recoveryMacDiagnosticSnapshot struct {
	LocalPairID string             `json:"localPairId"`
	Known       bool               `json:"known"`
	ObservedAt  *time.Time         `json:"observedAt"`
	State       *peersession.State `json:"state"`
}

type recoveryMacDiagnosticObservation struct {
	latest atomic.Pointer[recoveryMacDiagnosticSnapshot]
}

// A single bounded last-observed slot, not a Manager read or authoritative
// current-state cache. A different-direction/latest attempt means unknown.
func (observation *recoveryMacDiagnosticObservation) observe(localPair string, state peersession.State) {
	if !protocol.ValidID(localPair) || state.PairID != localPair || !protocol.ValidNonce(state.AttemptID) ||
		!protocol.ValidGeneration(state.Generation) || !recoveryInitialObservedStage(state.Stage) {
		return
	}
	if state.Error != "" {
		state.Error = recoveryInitialDiagnosticCode(errors.New(state.Error))
	}
	state.Path.LocalType, state.Path.RemoteType, state.Path.Protocol = "", "", ""
	at := time.Now().UTC()
	observation.latest.Store(&recoveryMacDiagnosticSnapshot{LocalPairID: localPair, Known: true, ObservedAt: &at, State: &state})
}

func recoveryInitialObservedStage(stage string) bool {
	switch stage {
	case "punching", "starting-runtime", "connected", "ready", "suspended", "disconnected", "failed":
		return true
	default:
		return false
	}
}

func (snapshot recoveryMacDiagnosticSnapshot) admitted(localPair string, scope recoveryDiagnosticScope) bool {
	if snapshot.LocalPairID != localPair {
		return false
	}
	if !snapshot.Known {
		return snapshot.State == nil && snapshot.ObservedAt == nil
	}
	state := snapshot.State
	return recoveryDiagnosticExact(scope) && state != nil && snapshot.ObservedAt != nil &&
		state.PairID == localPair && state.AttemptID == scope.AttemptID && state.Generation == scope.Generation &&
		recoveryInitialObservedStage(state.Stage) && state.Path.LocalType == "" && state.Path.RemoteType == "" && state.Path.Protocol == "" &&
		(state.Error == "" || state.Error == "unknown" || recoveryInitialDiagnosticCode(errors.New(state.Error)) == state.Error)
}

func (observation *recoveryMacDiagnosticObservation) snapshot(localPair string, scope recoveryDiagnosticScope) recoveryMacDiagnosticSnapshot {
	unknown := recoveryMacDiagnosticSnapshot{LocalPairID: localPair}
	latest := observation.latest.Load()
	if !recoveryDiagnosticExact(scope) || latest == nil || latest.LocalPairID != localPair ||
		latest.State.AttemptID != scope.AttemptID || latest.State.Generation != scope.Generation {
		return unknown
	}
	copy := *latest
	state, at := *latest.State, *latest.ObservedAt
	copy.State, copy.ObservedAt = &state, &at
	return copy
}

func TestRecoveryInitialDiagnosticsClassifiesActualPhaseAndPreservesError(t *testing.T) {
	for _, phase := range []string{"initial_transport", "initial_catalog", "initial_business_open", "initial_entry", "initial_reverse_open"} {
		t.Run(phase, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			ctx, cancel := context.WithCancel(wire.f.ctx)
			defer cancel()
			original := errors.New("sentinel-private-url-and-token")
			trace := recoveryInitialTrace{phase: "initial_transport"}
			if phase == "initial_transport" {
				wire.owner.current.Stage = "punching"
				cancel()
				original = context.Canceled
			}
			call := trace.call(func(ctx context.Context, method string, payload any) (json.RawMessage, error) {
				if trace.phase == phase {
					return nil, original
				}
				return wire.call(ctx, method, payload)
			})
			reverse := trace.reverse(func() error { return original })
			_, err := recoveryInitializeCross(ctx, wire.owner.peer, call, wire.f, wire.owner, "program-pause", reverse)
			failure := recoveryInitialFailure{Phase: trace.phase, cause: err}
			if trace.phase != phase || !errors.Is(failure, original) || strings.Contains(failure.Error(), "sentinel") {
				t.Fatal("initial failure lost its exact phase/cause or exposed unstructured error", failure)
			}
		})
	}
}

func TestRecoveryInitialDiagnosticsSealBeforeIndependentBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		acceptance, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		<-acceptance.Done()
		cancel()
		trace := recoveryInitialTrace{phase: "initial_transport", err: acceptance.Err()}
		var order []string
		started := time.Now()
		if !trace.diagnose(true, func(failure recoveryInitialFailure) {
			order = append(order, "failed_sealed")
			if !errors.Is(failure, context.DeadlineExceeded) {
				t.Fatal("diagnostic changed original acceptance failure")
			}
		}, func(ctx context.Context) {
			order = append(order, "diagnostic_acceptance_false")
			deadline, ok := ctx.Deadline()
			if ctx.Err() != nil || !ok || deadline.Sub(started) != 10*time.Second {
				t.Fatal("expired initial ctx swallowed diagnostics or changed the independent 10s budget")
			}
			<-ctx.Done()
		}) || !reflect.DeepEqual(order, []string{"failed_sealed", "diagnostic_acceptance_false"}) || time.Since(started) != 10*time.Second || trace.accepted {
			t.Fatal("diagnostic scheduling changed failure/order/budget")
		}
	})
}

func TestRecoveryInitialDiagnosticScopeUnknownNeverDispatchesEntry(t *testing.T) {
	for _, name := range []string{"missing-owner", "missing-core", "replaced", "wrong-pair", "invalid-attempt", "missing-generation", "owner-error", "known"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			core, owner := wire.owner.peer, wire.owner
			switch name {
			case "missing-owner":
				owner = nil
			case "missing-core":
				core = nil
			case "replaced":
				owner.peer = new(localrpc.Peer)
			case "wrong-pair":
				owner.current.PairID = protocol.NewID()
			case "invalid-attempt":
				owner.current.AttemptID = "not-an-attempt"
			case "missing-generation":
				owner.current.Generation = 0
			case "owner-error":
				owner.err = errors.New("test.initial_transport_owner_changed")
			}
			scope := recoveryInitialDiagnosticScope(wire.f.authority.ServiceID, wire.owner.pair, core, owner)
			var methods []string
			recoveryCoreReadDiagnostic(t, context.Background(), func(_ context.Context, method string, _ any) (json.RawMessage, error) {
				methods = append(methods, method)
				return nil, context.DeadlineExceeded
			}, scope)
			expected := []string{"core.version"}
			if name == "known" {
				expected = append(expected, "peer.entry")
			} else if scope.AttemptID != "" || scope.Generation != 0 {
				t.Fatal("unknown original scope was inferred")
			}
			if !reflect.DeepEqual(methods, expected) {
				t.Fatal("unknown scope dispatched Entry or diagnostic retried", methods)
			}
		})
	}
}

func TestRecoveryInitialDiagnosticsSkipUnfailedAndAccepted(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		for _, failed := range []bool{false, true} {
			trace := recoveryInitialTrace{phase: "initial_reverse_open", accepted: accepted}
			calls := 0
			started := trace.diagnose(failed, func(recoveryInitialFailure) { calls++ }, func(context.Context) { calls++ })
			if started != (failed && !accepted) || calls != 0 && calls != 2 || started != (calls == 2) {
				t.Fatal("unfailed Goexit or accepted initialization gained diagnostics")
			}
		}
	}
}

func TestRecoveryInitialMacSnapshotKeepsDirectionalScope(t *testing.T) {
	const service, windowsPair, macPair = "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"
	scope := recoveryDiagnosticScope{ServiceID: service, PairID: windowsPair, AttemptID: protocol.NewNonce(), Generation: 10}
	state := peersession.State{PairID: macPair, AttemptID: scope.AttemptID, Generation: scope.Generation, Stage: "punching", Error: "sentinel-secret"}
	var observed recoveryMacDiagnosticObservation
	if snapshot := observed.snapshot(macPair, scope); snapshot.Known || snapshot.State != nil || snapshot.ObservedAt != nil {
		t.Fatal("absent observation was invented")
	}
	observed.observe(macPair, state)
	snapshot := observed.snapshot(macPair, scope)
	if !snapshot.Known || !snapshot.admitted(macPair, scope) || snapshot.LocalPairID != macPair || snapshot.State.PairID == scope.PairID || snapshot.State.Error != "unknown" {
		t.Fatal("diagnostic borrowed the opposite pair or exposed an unstructured error")
	}
	snapshot.State.AttemptID = "caller-mutation"
	if observed.snapshot(macPair, scope).State.AttemptID != scope.AttemptID {
		t.Fatal("diagnostic exposed its stored snapshot")
	}
	for _, invalid := range []recoveryDiagnosticScope{{ServiceID: service, PairID: windowsPair}, {ServiceID: service, PairID: windowsPair, AttemptID: protocol.NewNonce(), Generation: 10}, {ServiceID: service, PairID: windowsPair, AttemptID: scope.AttemptID, Generation: 11}} {
		if actual := observed.snapshot(macPair, invalid); actual.Known || actual.State != nil {
			t.Fatal("unknown/replaced attempt borrowed last-observed authority")
		}
	}
	for _, mutate := range []func(*recoveryMacDiagnosticSnapshot){
		func(s *recoveryMacDiagnosticSnapshot) { s.LocalPairID = windowsPair },
		func(s *recoveryMacDiagnosticSnapshot) { s.State.Stage = "sentinel-secret" },
		func(s *recoveryMacDiagnosticSnapshot) { s.State.Error = "sentinel-secret" },
		func(s *recoveryMacDiagnosticSnapshot) { s.State.Generation++ },
	} {
		invalid := observed.snapshot(macPair, scope)
		mutate(&invalid)
		if invalid.admitted(macPair, scope) {
			t.Fatal("unscoped or unbounded Mac response was admitted")
		}
	}
}
