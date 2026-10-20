//go:build live

package integration

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peersession"
)

type recoveryNetworkPlan struct {
	Name      string
	Direction string
	Duration  time.Duration
	Repeats   int
	Clear     time.Duration
	Long      bool
}

func recoveryNetworkCasePlan(name string) (recoveryNetworkPlan, error) {
	plans := map[string]recoveryNetworkPlan{
		"short-inbound":  {"short-inbound", "inbound", 3 * time.Second, 1, 0, false},
		"short-outbound": {"short-outbound", "outbound", 3 * time.Second, 1, 0, false},
		"long-inbound":   {"long-inbound", "inbound", 35 * time.Second, 1, 0, true},
		"long-outbound":  {"long-outbound", "outbound", 35 * time.Second, 1, 0, true},
		"flap-both":      {"flap-both", "both", 3 * time.Second, 5, 3 * time.Second, false},
	}
	plan, ok := plans[name]
	if !ok {
		return recoveryNetworkPlan{}, errors.New("test.network_fault_case_invalid")
	}
	return plan, nil
}

func recoveryValidateCrossPhase(phase, fault string) error {
	switch phase {
	case "forward-stress", "duplex", "core-crash":
		if fault != "" {
			return errors.New("test.network_fault_case_outside_phase")
		}
		return nil
	case "network-fault":
		_, err := recoveryNetworkCasePlan(fault)
		return err
	case "program-pause":
		_, err := recoveryProgramCasePlan(fault)
		return err
	default:
		return errors.New("test.cross_phase_invalid")
	}
}

func recoveryScenarioLifetime(cycles, idle int, phase, fault string) time.Duration {
	if err := recoveryValidateCrossPhase(phase, fault); err != nil {
		panic(err) // Admission must precede lifetime calculation; never choose another phase.
	}
	if phase == "core-crash" {
		return 250 * time.Second
	}
	if phase == "program-pause" {
		plan, err := recoveryProgramCasePlan(fault)
		if err != nil {
			panic(err)
		}
		return 250*time.Second + time.Duration(plan.Repeats)*plan.Duration + time.Duration(plan.Repeats-1)*plan.Clear
	}
	if phase != "network-fault" {
		return recoveryCrossLifetime(cycles, idle, phase)
	}
	plan, err := recoveryNetworkCasePlan(fault)
	if err != nil {
		panic(err)
	}
	// Startup/readback owners plus the real injection, unchanged 25s success
	// boundary and 45s post-failure observation. No production timer is changed.
	return 180*time.Second + time.Duration(plan.Repeats)*plan.Duration + time.Duration(plan.Repeats-1)*plan.Clear + 25*time.Second + 45*time.Second
}

func recoveryNetworkFaultCase(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, owned recoveryOwnedCore, events <-chan peersession.State, owner *recoveryWindowsOwner, windows *recoveryWindowsRuntime, reverseInitial *recoveryReverseStatus, browser *recoveryBrowser, workspace recoveryWorkspace, session string, stream *recoveryWS, first peersession.Connected, macPID int) {
	t.Helper()
	plan, err := recoveryNetworkCasePlan(config.NetworkFaultCase)
	must(t, err)
	controller := recoveryStartFirewall(t, ctx, owned.Binary, owned.Process.cmd.Process.Pid, os.Getpid())
	armed := recoveryCrossControl(t, ctx, config, "/reverse-network-arm")
	if armed.Network == nil || !armed.Network.Armed || armed.Network.Case != plan.Name || !armed.Network.SameCookie || armed.Network.InitialAttempt != reverseInitial.State.AttemptID || armed.Reverse == nil || armed.Reverse.State != reverseInitial.State || armed.RuntimePID != macPID || !armed.RuntimeAlive {
		t.Fatal("network fault did not arm its original reverse application identities")
	}
	cookie := browser.cookieDigest(t)
	if plan.Long {
		stream.mu.Lock()
		stream.expectLoss = true
		stream.mu.Unlock()
	}
	t.Logf("network-fault-begin case=%s direction=%s durationMilliseconds=%d repeats=%d clearMilliseconds=%d corePid=%d parentPid=%d forwardAttempt=%s reverseAttempt=%s forwardWS=%s reverseWS=%s scope=isolated-core-all-udp windowsOwner=production-serve macOwner=production-engine-composition", plan.Name, plan.Direction, plan.Duration.Milliseconds(), plan.Repeats, plan.Clear.Milliseconds(), owned.Process.cmd.Process.Pid, os.Getpid(), first.State.AttemptID, reverseInitial.State.AttemptID, stream.id, reverseInitial.WSID)
	latest := first.State
	var released recoveryFirewallProof
	for round := 1; round <= plan.Repeats; round++ {
		proof, cutErr := recoveryObserveNetworkCut(t, ctx, controller, plan, stream, events, first.State, &latest)
		released = proof
		if cutErr != nil {
			t.Errorf("network fault injection failed case=%s round=%d code=%s", plan.Name, round, recoveryRedactRuntimeDiagnostic(cutErr.Error()))
			break
		}
		if !proof.IdentityVerified || proof.CorePID != owned.Process.cmd.Process.Pid || proof.Direction != plan.Direction || proof.ActiveRules != 0 || proof.RequestedMilliseconds != plan.Duration.Milliseconds() || proof.HeldMilliseconds < proof.RequestedMilliseconds || proof.ReleaseStartedAt.IsZero() || proof.ReleasedAt.Before(proof.ReleaseStartedAt) {
			t.Errorf("network fault proof rejected case=%s round=%d identity=%t activeRules=%d heldMilliseconds=%d requestedMilliseconds=%d", plan.Name, round, proof.IdentityVerified, proof.ActiveRules, proof.HeldMilliseconds, proof.RequestedMilliseconds)
			break
		}
		t.Logf("network-fault-released case=%s round=%d direction=%s heldMilliseconds=%d activeRules=0 identityVerified=true releaseStartedAt=%s releasedAt=%s", plan.Name, round, plan.Direction, proof.HeldMilliseconds, proof.ReleaseStartedAt.UTC().Format(time.RFC3339Nano), proof.ReleasedAt.UTC().Format(time.RFC3339Nano))
		if round < plan.Repeats {
			recoveryObserveNetworkClear(t, ctx, plan.Clear, stream, events, first.State, &latest)
		}
	}
	// Stop the independent rule owner before application readback. Its registered
	// cleanup is idempotent and must still verify the same exact owned rules.
	cleanup, cancelCleanup := context.WithTimeout(context.Background(), 15*time.Second)
	closeErr := controller.Close(cleanup)
	cancelCleanup()
	if closeErr != nil {
		t.Errorf("network fault controller cleanup failed: %s", recoveryRedactRuntimeDiagnostic(closeErr.Error()))
	}
	if released.ReleaseStartedAt.IsZero() || released.ActiveRules != 0 || closeErr != nil {
		t.Fatal("network recovery cannot be accepted without verified firewall release")
	}
	// ReleaseStartedAt is generated on this Windows host, never compared with
	// Mac timestamps. PowerShell release/readback/return time consumes this budget.
	deadline := released.ReleaseStartedAt.Add(25 * time.Second)
	acceptance, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	deadlineReported := false
	reportDeadline := func() {
		if deadlineReported {
			return
		}
		deadlineReported = true
		t.Errorf("network automatic recovery/readback did not complete within 25s from release start; state=%s", recoveryJSON(t, latest))
		recoveryCrossFailureDiagnostics(t, ctx, config, owned.Peer, events, first.State.PairID, latest)
	}
	defer func() {
		// testing.Fatal exits via Goexit, which still runs this diagnostic owner.
		// A per-request helper hitting the parent deadline cannot skip first-fail
		// retention or the existing natural post-deadline observation.
		if errors.Is(acceptance.Err(), context.DeadlineExceeded) {
			reportDeadline()
		}
	}()
	reverse := recoveryWaitNetworkReady(t, acceptance, config, events, first.State, &latest, plan, reportDeadline)
	if plan.Long {
		originalWS := stream.id
		assertRecoveryStreamClosed(t, acceptance, stream)
		stream = browser.readback(t, acceptance, workspace, session)
		if stream.id == originalWS {
			t.Fatal("long network recovery falsely reused its naturally closed forward WS")
		}
	} else {
		if latest != first.State {
			t.Fatal("short network fault replaced the original forward attempt")
		}
		browser.readbackExisting(t, acceptance, workspace, session, stream)
	}
	if recoveryEntry(t, acceptance, owned.Peer, f, latest) != first.URL || browser.cookieDigest(t) != cookie {
		t.Fatal("automatic network recovery moved the original gateway or cookie")
	}
	windows.assertRunning(t, acceptance, owned.Peer)
	answer := recoveryCrossControl(t, acceptance, config, "/reverse-network-readback")
	if answer.Network == nil || !answer.Network.ReadbackComplete || !answer.Network.SameCookie || answer.Network.OriginalWS != !plan.Long || answer.Reverse == nil || answer.Reverse.State != reverse.State || answer.Reverse.WorkspaceID != reverseInitial.WorkspaceID || answer.Reverse.SessionID != reverseInitial.SessionID || answer.OwnerCalls != 1 || answer.RuntimePID != macPID || !answer.RuntimeAlive || owner.opens.Load() != 1 || windows.startCalls != 1 {
		t.Fatal("network recovery lost exact reverse gateway/cookie/session/runtime ownership")
	}
	if plan.Long && (answer.Network.EngineAttempts == 0 || owner.resumes.Load() == 0 || answer.ResumeCalls == 0) || !plan.Long && (answer.Network.EngineAttempts != 0 || owner.resumes.Load() != 0 || answer.ResumeCalls != 0 || answer.Reverse.WSID != reverseInitial.WSID) {
		t.Fatal("network recovery did not retain the required automatic/unchanged owner path")
	}
	if acceptance.Err() != nil || !time.Now().Before(deadline) {
		reportDeadline()
		t.FailNow()
	}
	recoveryElapsed := time.Since(released.ReleaseStartedAt)
	cancel() // Application acceptance is sealed; finish/cleanup owns its own context.
	t.Logf("network-fault-readback direction=windows-to-macos case=%s trigger=serve-periodic pair=%s attempt=%s generation=%d runtimeGeneration=%d workspace=%s session=%s ws=%s originalWS=%t sameGateway=true sameCookie=true runtimePid=%d", plan.Name, latest.PairID, latest.AttemptID, latest.Generation, latest.RuntimeGeneration, workspace.ID, session, stream.id, !plan.Long, macPID)
	t.Logf("network-fault-readback direction=mac-to-windows case=%s trigger=production-engine pair=%s attempt=%s generation=%d runtimeGeneration=%d workspace=%s session=%s ws=%s originalWS=%t sameGateway=true sameCookie=true engineAttempts=%d runtimePid=%d", plan.Name, answer.Reverse.State.PairID, answer.Reverse.State.AttemptID, answer.Reverse.State.Generation, answer.Reverse.State.RuntimeGeneration, answer.Reverse.WorkspaceID, answer.Reverse.SessionID, answer.Reverse.WSID, !plan.Long, answer.Network.EngineAttempts, windows.launch.PID)
	must(t, stream.SealCloseJoin())
	sealed := recoveryCrossControl(t, ctx, config, "/reverse-seal")
	recoveryRequireSealed(t, sealed, answer.Reverse)
	finished := recoveryCrossControl(t, ctx, config, "/finish")
	recoveryRequireSealed(t, finished, answer.Reverse)
	if finished.OwnerCalls != 1 || !finished.RuntimeAlive || finished.RuntimePID != macPID {
		t.Fatal("network case cleanup changed the independent real Mac runtime")
	}
	if t.Failed() {
		t.FailNow()
	}
	t.Logf("network-fault-completed case=%s repeats=%d recoveryMilliseconds=%d deadlineMilliseconds=25000 activeRules=0 sameCookieSession=true windowsColdCalls=%d macColdCalls=%d originalWS=%t noManualReconnect=true", plan.Name, plan.Repeats, recoveryElapsed.Milliseconds(), owner.opens.Load(), finished.OwnerCalls, !plan.Long)
}

func recoveryObserveNetworkCut(t *testing.T, ctx context.Context, controller *recoveryFirewall, plan recoveryNetworkPlan, stream *recoveryWS, events <-chan peersession.State, first peersession.State, latest *peersession.State) (recoveryFirewallProof, error) {
	t.Helper()
	type result struct {
		proof recoveryFirewallProof
		err   error
	}
	done := make(chan result, 1)
	go func() {
		proof, err := controller.Cut(ctx, plan.Direction, plan.Duration)
		done <- result{proof, err}
	}()
	reader := stream.done
	for {
		select {
		case answer := <-done:
			return answer.proof, answer.err
		case <-reader:
			recoveryNetworkReaderEnded(t, stream, plan.Long)
			reader = nil
		case state := <-events:
			recoveryNetworkEvent(t, state, first, latest, plan.Long)
		case <-ctx.Done():
			// The firewall owner has an independent bounded cleanup context.
			return recoveryFirewallProof{}, ctx.Err()
		}
	}
}

func recoveryNetworkReaderEnded(t *testing.T, stream *recoveryWS, allowed bool) {
	t.Helper()
	stream.mu.Lock()
	err, appError, localClose := stream.err, stream.appError, stream.localClose
	stream.mu.Unlock()
	if !allowed || err == nil || appError || localClose {
		t.Errorf("network fault original WS ended caseAllowsNaturalClose=%t ws=%s appError=%t localClose=%t", allowed, stream.id, appError, localClose)
	}
}

func recoveryNetworkEvent(t *testing.T, state, first peersession.State, latest *peersession.State, allowReplacement bool) {
	t.Helper()
	if state.PairID != first.PairID {
		return
	}
	// Inbound counterpart events share the pair but never publish outbound ready.
	if state.Stage == "ready" && state.RuntimeGeneration == first.RuntimeGeneration && state.Generation >= latest.Generation {
		*latest = state
		if !allowReplacement && state != first {
			t.Errorf("short network fault replaced its original forward attempt old=%s new=%s", first.AttemptID, state.AttemptID)
		}
	}
	t.Logf("network-fault-state pair=%s attempt=%s generation=%d stage=%s error=%s", state.PairID, state.AttemptID, state.Generation, state.Stage, state.Error)
}

func recoveryObserveNetworkClear(t *testing.T, ctx context.Context, duration time.Duration, stream *recoveryWS, events <-chan peersession.State, first peersession.State, latest *peersession.State) {
	t.Helper()
	timer := time.NewTimer(duration)
	defer timer.Stop()
	reader := stream.done
	for {
		select {
		case <-timer.C:
			return
		case <-reader:
			recoveryNetworkReaderEnded(t, stream, false)
			reader = nil
		case state := <-events:
			recoveryNetworkEvent(t, state, first, latest, false)
		case <-ctx.Done():
			t.Errorf("network clear interval interrupted: %v", ctx.Err())
			return
		}
	}
}

func recoveryWaitNetworkReady(t *testing.T, acceptance context.Context, config recoveryCrossConfig, events <-chan peersession.State, first peersession.State, latest *peersession.State, plan recoveryNetworkPlan, onDeadline func()) *recoveryReverseStatus {
	t.Helper()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case state := <-events:
			recoveryNetworkEvent(t, state, first, latest, plan.Long)
		case <-ticker.C:
			answer, err := recoveryNetworkControl(acceptance, config, "/reverse-network-state")
			if err != nil {
				if acceptance.Err() != nil {
					onDeadline()
					t.FailNow()
				}
				t.Fatalf("network control observation failed: %v", err)
			}
			reverse := answer.Reverse
			if answer.Network == nil || !answer.Network.Armed || answer.Network.Case != plan.Name {
				t.Fatal("network observation lost its admitted Mac fault owner")
			}
			if reverse != nil && reverse.State.Stage == "ready" && latest.Stage == "ready" {
				if plan.Long && (latest.AttemptID == first.AttemptID || latest.Generation <= first.Generation || reverse.State.AttemptID == answer.Network.InitialAttempt) {
					continue
				}
				return reverse
			}
		case <-acceptance.Done():
			onDeadline()
			t.FailNow()
		}
	}
}

func TestWorkbenchRecoveryNetworkPlans(t *testing.T) {
	for _, name := range []string{"short-inbound", "short-outbound", "long-inbound", "long-outbound", "flap-both"} {
		plan, err := recoveryNetworkCasePlan(name)
		if err != nil || plan.Name != name || plan.Repeats < 1 || plan.Duration != 3*time.Second && plan.Duration != 35*time.Second || plan.Long != (plan.Duration == 35*time.Second) {
			t.Fatalf("invalid explicit network plan %s", name)
		}
		if err := recoveryValidateCrossPhase("network-fault", name); err != nil {
			t.Fatal(err)
		}
		want := 250*time.Second + time.Duration(plan.Repeats)*plan.Duration + time.Duration(plan.Repeats-1)*plan.Clear
		if got := recoveryScenarioLifetime(3, 28800, "network-fault", name); got != want {
			t.Fatalf("outer network owner budget got=%s want=%s", got, want)
		}
	}
	for _, input := range [][2]string{{"network-fault", ""}, {"network-fault", "guessed"}, {"duplex", "short-inbound"}, {"all", ""}} {
		if err := recoveryValidateCrossPhase(input[0], input[1]); err == nil {
			t.Fatal(fmt.Sprintf("invalid cross admission accepted %q", input))
		}
	}
}
