//go:build live

package integration

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peersession"
)

// Approved replacement for the unenforceable UDP profile. Pausing a program
// stops its signal, lease and transport workers together; this is not packet loss.
func recoveryProgramCasePlan(name string) (recoveryNetworkPlan, error) {
	plans := map[string]recoveryNetworkPlan{
		"short-process": {"short-process", "program", 3 * time.Second, 1, 0, false},
		"long-process":  {"long-process", "program", 35 * time.Second, 1, 0, true},
		"flap-process":  {"flap-process", "program", 3 * time.Second, 5, 3 * time.Second, false},
	}
	plan, ok := plans[name]
	if !ok {
		return recoveryNetworkPlan{}, errors.New("test.program_pause_case_invalid")
	}
	return plan, nil
}

func recoveryProgramBudget(now, released uint64) (time.Duration, error) {
	if released == 0 || now < released || now-released >= 25000 {
		return 0, errors.New("test.program_pause_release_budget_expired_or_invalid")
	}
	return time.Duration(25000-(now-released)) * time.Millisecond, nil
}

func recoveryObserveProgramPause(t *testing.T, ctx context.Context, controller *recoveryPauseController, plan recoveryNetworkPlan, stream *recoveryWS, events <-chan peersession.State, first peersession.State, latest *peersession.State) (recoveryPauseProof, error) {
	t.Helper()
	type result struct {
		proof recoveryPauseProof
		err   error
	}
	done := make(chan result, 1)
	go func() {
		proof, err := controller.Pause(ctx, plan.Duration)
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
			return recoveryPauseProof{}, ctx.Err()
		}
	}
}

func recoveryProgramPauseCase(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, owned recoveryOwnedCore, events <-chan peersession.State, owner *recoveryWindowsOwner, windows *recoveryWindowsRuntime, reverseInitial *recoveryReverseStatus, browser *recoveryBrowser, workspace recoveryWorkspace, session string, stream *recoveryWS, first peersession.Connected, macPID int) {
	t.Helper()
	plan, err := recoveryProgramCasePlan(config.NetworkFaultCase)
	must(t, err)
	controller := recoveryStartProgramPause(t, ctx, owned.Binary, owned.Process.cmd.Process.Pid, os.Getpid())
	armed := recoveryCrossControl(t, ctx, config, "/reverse-network-arm")
	if armed.Network == nil || !armed.Network.Armed || armed.Network.Case != plan.Name || !armed.Network.SameCookie || armed.Network.InitialAttempt != reverseInitial.State.AttemptID || armed.Reverse == nil || armed.Reverse.State != reverseInitial.State || armed.RuntimePID != macPID || !armed.RuntimeAlive {
		t.Fatal("program pause did not arm its original reverse application identities")
	}
	cookie := browser.cookieDigest(t)
	if plan.Long {
		stream.mu.Lock()
		stream.expectLoss = true
		stream.mu.Unlock()
	}
	t.Logf("program-pause-begin case=%s durationMilliseconds=%d repeats=%d clearMilliseconds=%d corePid=%d parentPid=%d forwardAttempt=%s reverseAttempt=%s forwardWS=%s reverseWS=%s scope=isolated-core-program windowsOwner=production-serve macOwner=production-engine-composition firewallChanged=false networkChanged=false", plan.Name, plan.Duration.Milliseconds(), plan.Repeats, plan.Clear.Milliseconds(), owned.Process.cmd.Process.Pid, os.Getpid(), first.State.AttemptID, reverseInitial.State.AttemptID, stream.id, reverseInitial.WSID)
	latest := first.State
	var released recoveryPauseProof
	for round := 1; round <= plan.Repeats; round++ {
		proof, pauseErr := recoveryObserveProgramPause(t, ctx, controller, plan, stream, events, first.State, &latest)
		t.Logf("program-pause-proof %s", recoveryJSON(t, proof))
		if pauseErr != nil || !proof.IdentityVerified || !proof.CleanupConfirmed || proof.GuardTerminatedController || proof.Outcome != "resumed" || proof.ErrorCode != "" || proof.CorePID != owned.Process.cmd.Process.Pid || proof.RequestedHeldMilliseconds != plan.Duration.Milliseconds() || proof.ReleaseStartedAt.IsZero() || proof.PausedTickMilliseconds == 0 || proof.ReleaseStartedTickMilliseconds < proof.PausedTickMilliseconds || proof.ReleaseStartedTickMilliseconds-proof.PausedTickMilliseconds < uint64(plan.Duration.Milliseconds()) || proof.ReleasedTickMilliseconds < proof.ReleaseStartedTickMilliseconds {
			t.Errorf("program pause injection rejected case=%s round=%d error=%v", plan.Name, round, pauseErr)
			break
		}
		released = proof
		t.Logf("program-pause-released case=%s round=%d heldMilliseconds=%d identityVerified=true cleanupConfirmed=true outcome=resumed releaseStartedAt=%s releasedAt=%s releaseStartedTickMilliseconds=%d", plan.Name, round, proof.ReleaseStartedTickMilliseconds-proof.PausedTickMilliseconds, proof.ReleaseStartedAt.UTC().Format(time.RFC3339Nano), proof.ReleasedAt.UTC().Format(time.RFC3339Nano), proof.ReleaseStartedTickMilliseconds)
		if round < plan.Repeats {
			recoveryObserveNetworkClear(t, ctx, plan.Clear, stream, events, first.State, &latest)
		}
	}
	cleanup, cancelCleanup := context.WithTimeout(context.Background(), 8*time.Second)
	closeErr := controller.Close(cleanup)
	cancelCleanup()
	if closeErr != nil || released.ReleaseStartedAt.IsZero() || t.Failed() {
		t.Fatalf("program pause cannot be accepted without all verified releases and cleanup: %v", closeErr)
	}
	// All ticks belong to this Windows boot. Serialized UTC is diagnostic only:
	// wall-clock rollback cannot grant more time. Receipt and cleanup consume the
	// original release budget. Anchor before querying ticks so query time does
	// not extend the local monotonic context deadline either.
	anchor := time.Now()
	nowTick, err := recoveryPauseTickMilliseconds()
	must(t, err)
	remaining, err := recoveryProgramBudget(nowTick, released.ReleaseStartedTickMilliseconds)
	if err != nil {
		t.Errorf("program recovery deadline expired before readback: %v", err)
		recoveryCrossFailureDiagnostics(t, ctx, config, owned.Peer, events, first.State.PairID, latest)
		t.FailNow()
	}
	deadline := anchor.Add(remaining)
	acceptance, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	deadlineReported := false
	reportDeadline := func() {
		if !deadlineReported {
			deadlineReported = true
			t.Errorf("program automatic recovery/readback exceeded 25s from release start; state=%s", recoveryJSON(t, latest))
			recoveryCrossFailureDiagnostics(t, ctx, config, owned.Peer, events, first.State.PairID, latest)
		}
	}
	defer func() {
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
			t.Fatal("long program recovery falsely reused the naturally closed WS")
		}
	} else {
		if latest != first.State {
			t.Fatal("short program pause replaced the original forward attempt")
		}
		browser.readbackExisting(t, acceptance, workspace, session, stream)
	}
	if recoveryEntry(t, acceptance, owned.Peer, f, latest) != first.URL || browser.cookieDigest(t) != cookie {
		t.Fatal("program recovery moved the original gateway or cookie")
	}
	windows.assertRunning(t, acceptance, owned.Peer)
	answer := recoveryCrossControl(t, acceptance, config, "/reverse-network-readback")
	if answer.Network == nil || !answer.Network.ReadbackComplete || !answer.Network.SameCookie || answer.Network.OriginalWS != !plan.Long || answer.Reverse == nil || answer.Reverse.State != reverse.State || answer.Reverse.WorkspaceID != reverseInitial.WorkspaceID || answer.Reverse.SessionID != reverseInitial.SessionID || answer.OwnerCalls != 1 || answer.RuntimePID != macPID || !answer.RuntimeAlive || owner.opens.Load() != 1 || windows.startCalls != 1 {
		t.Fatal("program recovery lost the original reverse gateway/cookie/session/runtime")
	}
	if plan.Long && (answer.Network.EngineAttempts == 0 || owner.resumes.Load() == 0 || answer.ResumeCalls == 0) || !plan.Long && (answer.Network.EngineAttempts != 0 || owner.resumes.Load() != 0 || answer.ResumeCalls != 0 || answer.Reverse.WSID != reverseInitial.WSID) {
		t.Fatal("program recovery changed its required automatic/original owner path")
	}
	completedTick, err := recoveryPauseTickMilliseconds()
	must(t, err)
	if _, budgetErr := recoveryProgramBudget(completedTick, released.ReleaseStartedTickMilliseconds); budgetErr != nil || acceptance.Err() != nil || !time.Now().Before(deadline) {
		reportDeadline()
		t.FailNow()
	}
	elapsed := time.Duration(completedTick-released.ReleaseStartedTickMilliseconds) * time.Millisecond
	cancel()
	t.Logf("program-pause-readback direction=windows-to-macos case=%s trigger=serve-periodic pair=%s attempt=%s generation=%d runtimeGeneration=%d workspace=%s session=%s ws=%s originalWS=%t sameGateway=true sameCookie=true runtimePid=%d", plan.Name, latest.PairID, latest.AttemptID, latest.Generation, latest.RuntimeGeneration, workspace.ID, session, stream.id, !plan.Long, macPID)
	t.Logf("program-pause-readback direction=mac-to-windows case=%s trigger=production-engine pair=%s attempt=%s generation=%d runtimeGeneration=%d workspace=%s session=%s ws=%s originalWS=%t sameGateway=true sameCookie=true engineAttempts=%d runtimePid=%d", plan.Name, answer.Reverse.State.PairID, answer.Reverse.State.AttemptID, answer.Reverse.State.Generation, answer.Reverse.State.RuntimeGeneration, answer.Reverse.WorkspaceID, answer.Reverse.SessionID, answer.Reverse.WSID, !plan.Long, answer.Network.EngineAttempts, windows.launch.PID)
	must(t, stream.SealCloseJoin())
	sealed := recoveryCrossControl(t, ctx, config, "/reverse-seal")
	recoveryRequireSealed(t, sealed, answer.Reverse)
	finished := recoveryCrossControl(t, ctx, config, "/finish")
	recoveryRequireSealed(t, finished, answer.Reverse)
	if finished.OwnerCalls != 1 || !finished.RuntimeAlive || finished.RuntimePID != macPID {
		t.Fatal("program cleanup changed the independent Mac runtime")
	}
	if t.Failed() {
		t.FailNow()
	}
	t.Logf("program-pause-completed case=%s repeats=%d recoveryMilliseconds=%d deadlineMilliseconds=25000 sameCookieSession=true windowsColdCalls=%d macColdCalls=%d originalWS=%t noManualReconnect=true cleanupConfirmed=true firewallChanged=false networkChanged=false", plan.Name, plan.Repeats, elapsed.Milliseconds(), owner.opens.Load(), finished.OwnerCalls, !plan.Long)
}

func TestWorkbenchRecoveryProgramPlans(t *testing.T) {
	for _, name := range []string{"short-process", "long-process", "flap-process"} {
		plan, err := recoveryProgramCasePlan(name)
		must(t, err)
		must(t, recoveryValidateCrossPhase("program-pause", name))
		if plan.Direction != "program" || plan.Long != (plan.Duration == 35*time.Second) || plan.Repeats < 1 {
			t.Fatal("invalid explicitly approved program plan")
		}
		want := 250*time.Second + time.Duration(plan.Repeats)*plan.Duration + time.Duration(plan.Repeats-1)*plan.Clear
		if got := recoveryScenarioLifetime(3, 28800, "program-pause", name); got != want {
			t.Fatalf("outer program owner budget got=%s want=%s", got, want)
		}
		if recoveryValidateCrossPhase("network-fault", name) == nil || recoveryValidateCrossPhase("duplex", name) == nil {
			t.Fatal("program case was misclassified as UDP or duplex")
		}
	}
	for _, name := range []string{"", "short-inbound", "guessed"} {
		if recoveryValidateCrossPhase("program-pause", name) == nil {
			t.Fatal("unspecified or UDP case became a program pause")
		}
	}
}

func TestWorkbenchRecoveryProgramBudgetUsesOnlyMonotonicReleaseTicks(t *testing.T) {
	for _, item := range []struct {
		now, released uint64
		remaining     time.Duration
	}{{50000, 50000, 25 * time.Second}, {50123, 50000, 24877 * time.Millisecond}, {74999, 50000, time.Millisecond}} {
		got, err := recoveryProgramBudget(item.now, item.released)
		if err != nil || got != item.remaining {
			t.Fatalf("original release budget changed got=%v err=%v", got, err)
		}
	}
	for _, item := range [][2]uint64{{0, 0}, {49999, 50000}, {75000, 50000}, {75001, 50000}, {^uint64(0), 1}} {
		if _, err := recoveryProgramBudget(item[0], item[1]); err == nil {
			t.Fatal("missing/backward/expired release ticks admitted")
		}
	}
}
