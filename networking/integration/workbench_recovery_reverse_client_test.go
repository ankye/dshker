//go:build live

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
)

func recoveryDuplexCase(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, core *localrpc.Peer, events <-chan peersession.State, owner *recoveryWindowsOwner, windows *recoveryWindowsRuntime, reverseInitial *recoveryReverseStatus, browser *recoveryBrowser, workspace recoveryWorkspace, session string, stream *recoveryWS, first peersession.Connected, previous peersession.State, seen map[string]bool, runtimePID int, waitState func(uint64, string) peersession.State) {
	t.Helper()
	reverseAnswer := recoveryCrossControl(t, ctx, config, "/reverse-readback")
	reverse := recoveryRequireReverse(t, reverseAnswer, "ready", windows.binding.Generation)
	if reverse.State != reverseInitial.State || reverse.WSID != reverseInitial.WSID || reverse.Readbacks <= reverseInitial.Readbacks || reverse.State.PairID != config.Dialer.Device.DeviceID || reverse.State.AttemptID == previous.AttemptID || reverseAnswer.OwnerCalls != 1 || reverseAnswer.ResumeCalls != 0 || owner.opens.Load() != 1 || owner.resumes.Load() != 0 {
		t.Fatal("duplex initial directions lost their independent owner or attempt identities")
	}
	windows.assertRunning(t, ctx, core)
	recoveryForwardUnchanged(t, ctx, core, f, browser, workspace, session, stream, previous, first.URL, "reverse-open")
	t.Logf("duplex-ready service=%s network=%s windowsDevice=%s macDevice=%s forwardPair=%s forwardAttempt=%s forwardGeneration=%d reversePair=%s reverseAttempt=%s reverseGeneration=%d reverseRuntimeGeneration=%d windowsRuntimePid=%d macRuntimePid=%d forwardSession=%s reverseSession=%s reverseWS=%s", f.authority.ServiceID, config.Dialer.Pin.Pair.NetworkID, config.Dialer.Device.DeviceID, config.Remote.DeviceID, previous.PairID, previous.AttemptID, previous.Generation, reverse.State.PairID, reverse.State.AttemptID, reverse.State.Generation, reverse.State.RuntimeGeneration, windows.launch.PID, runtimePID, session, reverse.SessionID, reverse.WSID)
	reverse = recoveryDuplexApplicationIdle(t, ctx, config, f, core, windows, reverse, browser, workspace, session, stream, previous, first.URL, runtimePID)

	previous, reverse, stream = recoveryDuplexAutoCycles(t, ctx, config, f, core, events, owner, windows, browser, workspace, session, first, previous, reverse, stream, seen)
	resumeBaseline := owner.resumes.Load()
	// Temporary Mac owner refusal: the Windows production owner retains its
	// workbench request while the opposite Mac tab keeps its original live WS.
	denied := recoveryCrossControl(t, ctx, config, "/deny-workbench")
	if denied.Available || !denied.RuntimeAlive || denied.OwnerCalls != 1 || denied.ResumeCalls < int64(config.Cycles) {
		t.Fatal("temporary Mac refusal changed the real runtime or directional resume count")
	}
	recoveryCrossControl(t, ctx, config, "/invalidate-runtime")
	waitDisconnected(t, ctx, events, previous.AttemptID)
	browser.detached(t, ctx)
	assertRecoveryStreamClosed(t, ctx, stream)
	reverse = recoveryReverseUnchanged(t, ctx, config, reverse, "forward-refused")
	refused := waitState(previous.Generation, "connected")
	recoveryForwardFresh(t, seen, refused)
	if refused.Error != "p2p.runtime_unavailable" || refused.RuntimeGeneration != 0 || refused.AttemptID == previous.AttemptID {
		t.Fatalf("temporary resume refusal lost its owning state: %s", recoveryJSON(t, refused))
	}
	browser.detached(t, ctx)
	t.Logf("cross-resume-refusal service=%s pair=%s attempt=%s generation=%d error=%s runtimePid=%d trigger=serve-periodic", f.authority.ServiceID, refused.PairID, refused.AttemptID, refused.Generation, refused.Error, runtimePID)
	allowed := recoveryCrossControl(t, ctx, config, "/allow-workbench")
	if !allowed.Available || !allowed.RuntimeAlive || allowed.RuntimePID != runtimePID || allowed.OwnerCalls != 1 || allowed.ResumeCalls <= denied.ResumeCalls {
		t.Fatal("temporary refusal activated the Mac cold owner or changed its PID")
	}
	recovered := waitState(refused.Generation, "ready")
	recoveryForwardFresh(t, seen, recovered)
	if recovered.AttemptID == refused.AttemptID || recovered.RuntimeGeneration != 1 || recoveryEntry(t, ctx, core, f, recovered) != first.URL {
		t.Fatal("periodic retry after refusal did not recover the original gateway")
	}
	stream = browser.readback(t, ctx, workspace, session)
	reverse = recoveryReverseUnchanged(t, ctx, config, reverse, "forward-refusal-recovered")
	t.Logf("cross-refusal-recovered service=%s pair=%s attempt=%s generation=%d sameGateway=true workspace=%s session=%s trigger=serve-periodic", f.authority.ServiceID, recovered.PairID, recovered.AttemptID, recovered.Generation, workspace.ID, session)
	previous = recovered

	// Inject a temporary refusal only at the scoped test-parent binding read.
	// The underlying Windows supervisor and DSH remain genuinely running.
	owner.allowed.Store(false)
	recoveryCall(t, ctx, core, f, "runtime.invalidate", map[string]any{"generation": windows.binding.Generation})
	recoveryForwardUnchanged(t, ctx, core, f, browser, workspace, session, stream, previous, first.URL, "reverse-refused")
	refusedReverse := recoveryRequireReverse(t, recoveryCrossControl(t, ctx, config, "/reverse-await-refused"), "connected", 0)
	recoveryReverseAdvanced(t, reverse, refusedReverse)
	windows.assertRunning(t, ctx, core)
	if owner.opens.Load() != 1 || owner.resumes.Load() <= resumeBaseline {
		t.Fatal("reverse temporary refusal did not use only the resume owner")
	}
	t.Logf("reverse-resume-refusal trigger=production-autoconnect-engine pair=%s attempt=%s generation=%d error=%s runtimePid=%d", refusedReverse.State.PairID, refusedReverse.State.AttemptID, refusedReverse.State.Generation, refusedReverse.State.Error, windows.launch.PID)
	resumeBaseline = owner.resumes.Load()
	owner.allowed.Store(true)
	reverse = recoveryRequireReverse(t, recoveryCrossControl(t, ctx, config, "/reverse-await-ready"), "ready", windows.binding.Generation)
	recoveryReverseAdvanced(t, refusedReverse, reverse)
	if reverse.WorkspaceID != refusedReverse.WorkspaceID || reverse.SessionID != refusedReverse.SessionID || owner.opens.Load() != 1 || owner.resumes.Load() <= resumeBaseline {
		t.Fatal("reverse refusal recovery replaced the original session or used cold open")
	}
	windows.assertRunning(t, ctx, core)
	recoveryForwardUnchanged(t, ctx, core, f, browser, workspace, session, stream, previous, first.URL, "reverse-refusal-recovered")
	t.Logf("reverse-refusal-recovered trigger=production-autoconnect-engine pair=%s attempt=%s generation=%d sameGateway=true workspace=%s session=%s", reverse.State.PairID, reverse.State.AttemptID, reverse.State.Generation, reverse.WorkspaceID, reverse.SessionID)

	// Stop the actual Mac DSH while the reverse tab still browses Windows DSH.
	stopped := recoveryCrossControl(t, ctx, config, "/stop-runtime")
	if stopped.RuntimeAlive || stopped.Available || stopped.RuntimePID != runtimePID || stopped.OwnerCalls != 1 {
		t.Fatal("test-owned Mac DSH did not stop at its original PID")
	}
	waitDisconnected(t, ctx, events, previous.AttemptID)
	browser.detached(t, ctx)
	assertRecoveryStreamClosed(t, ctx, stream)
	reverse = recoveryReverseUnchanged(t, ctx, config, reverse, "mac-runtime-stopped")
	stoppedState := waitState(previous.Generation, "connected")
	recoveryForwardFresh(t, seen, stoppedState)
	if stoppedState.Error != "p2p.runtime_unavailable" || stoppedState.RuntimeGeneration != 0 || owner.opens.Load() != 1 {
		t.Fatalf("periodic recovery misreported the stopped Mac runtime: %s", recoveryJSON(t, stoppedState))
	}
	browser.detached(t, ctx)
	reverse = recoveryReverseUnchanged(t, ctx, config, reverse, "mac-runtime-stayed-stopped")
	macStopped := recoveryCrossControl(t, ctx, config, "/reverse-readback")
	if macStopped.RuntimeAlive || macStopped.RuntimePID != runtimePID || macStopped.OwnerCalls != 1 || macStopped.ResumeCalls <= stopped.ResumeCalls {
		t.Fatal("stopped Mac DSH was reactivated by periodic recovery")
	}
	reverse = recoveryRequireReverse(t, macStopped, "ready", windows.binding.Generation)
	t.Logf("cross-stopped-runtime service=%s pair=%s attempt=%s generation=%d error=%s originalPid=%d originalPidAlive=false coldCalls=%d resumeCalls=%d trigger=serve-periodic", f.authority.ServiceID, stoppedState.PairID, stoppedState.AttemptID, stoppedState.Generation, stoppedState.Error, runtimePID, macStopped.OwnerCalls, macStopped.ResumeCalls)

	// Stop and reap the actual core-owned Windows child. Resume cannot start a
	// replacement even though its direction retains the original workbench intent.
	windows.stop(t, ctx, core)
	resumeBaseline = owner.resumes.Load()
	recoveryCall(t, ctx, core, f, "runtime.invalidate", map[string]any{"generation": windows.binding.Generation})
	stoppedReverse := recoveryRequireReverse(t, recoveryCrossControl(t, ctx, config, "/reverse-await-refused"), "connected", 0)
	recoveryReverseAdvanced(t, reverse, stoppedReverse)
	windows.assertStopped(t, ctx, core)
	if owner.opens.Load() != 1 || owner.resumes.Load() <= resumeBaseline {
		t.Fatal("stopped Windows DSH was cold-opened by reverse recovery")
	}
	t.Logf("reverse-stopped-runtime trigger=production-autoconnect-engine pair=%s attempt=%s generation=%d error=%s originalPid=%d originalPidAlive=false coldCalls=%d resumeCalls=%d startCalls=%d", stoppedReverse.State.PairID, stoppedReverse.State.AttemptID, stoppedReverse.State.Generation, stoppedReverse.State.Error, windows.launch.PID, owner.opens.Load(), owner.resumes.Load(), windows.startCalls)
	finished := recoveryCrossControl(t, ctx, config, "/finish")
	if finished.RuntimePID != runtimePID || finished.RuntimeAlive || finished.OwnerCalls != 1 || finished.ResumeCalls <= stopped.ResumeCalls {
		t.Fatal("stopped Mac DSH was activated during reverse recovery")
	}
	t.Logf("duplex-completed phase=duplex recoveryCycles=%d coldCalls=%d resumeCalls=%d sameSession=true stoppedRuntimeStayedStopped=true reverseCasesPassed=true", config.Cycles, finished.OwnerCalls, finished.ResumeCalls)
}

func recoveryDuplexApplicationIdle(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, core *localrpc.Peer, windows *recoveryWindowsRuntime, reverse *recoveryReverseStatus, browser *recoveryBrowser, workspace recoveryWorkspace, session string, stream *recoveryWS, state peersession.State, originalURL string, macPID int) *recoveryReverseStatus {
	t.Helper()
	begun := recoveryCrossControl(t, ctx, config, "/reverse-idle-begin")
	remote := recoveryRequireReverse(t, begun, "ready", windows.binding.Generation)
	if remote.State != reverse.State || remote.WSID != reverse.WSID || remote.SessionID != reverse.SessionID || remote.WorkspaceID != reverse.WorkspaceID || !begun.RuntimeAlive || begun.RuntimePID != macPID {
		t.Fatal("reverse idle began on a different original connection or runtime")
	}
	idle := browser.beginIdle(t, stream)
	browser.requireCookieLifetime(t, config.ResourceDeadlineUnix)
	t.Logf("idle-begin direction=windows-to-macos requiredSeconds=%d startedAt=%s ws=%s pair=%s attempt=%s generation=%d windowsRuntimePid=%d macRuntimePid=%d workspace=%s session=%s cookieSha256=%x", config.ApplicationIdleSeconds, idle.started.UTC().Format(time.RFC3339Nano), stream.id, state.PairID, state.AttemptID, state.Generation, windows.launch.PID, macPID, workspace.ID, session, idle.cookie)
	timer := time.NewTimer(time.Duration(config.ApplicationIdleSeconds) * time.Second)
	defer timer.Stop()
	progress := time.NewTicker(time.Minute)
	defer progress.Stop()
waiting:
	for {
		select {
		case <-timer.C:
			break waiting
		case <-progress.C:
			localProof := browser.idleProgress(t, idle, stream)
			sample := recoveryCrossControl(t, ctx, config, "/reverse-idle-progress")
			remoteSample := recoveryRequireReverse(t, sample, "ready", windows.binding.Generation)
			observed := remoteSample.ApplicationIdleProgress
			if observed == nil || remoteSample.State != reverse.State || remoteSample.WSID != reverse.WSID || remoteSample.SessionID != reverse.SessionID || remoteSample.WorkspaceID != reverse.WorkspaceID || observed.BusinessHTTPDelta != 0 || observed.BusinessWSDelta != 0 || !observed.OriginalWS || !observed.SameCookie || observed.WSID != reverse.WSID || !sample.RuntimeAlive || sample.RuntimePID != macPID {
				t.Fatal("reverse idle progress lost its original silent runtime/session/WS")
			}
			observation, cancel := context.WithTimeout(ctx, 5*time.Second)
			if recoveryEntry(t, observation, core, f, state) != originalURL {
				t.Fatal("idle progress moved its original forward gateway")
			}
			windows.assertRunning(t, observation, core)
			cancel()
			t.Logf("application-idle-progress direction=mac-to-windows elapsedSeconds=%.6f businessHTTPDelta=%d businessWSDelta=%d originalWS=%t ws=%s pair=%s attempt=%s generation=%d runtimeGeneration=%d windowsRuntimePid=%d workspace=%s session=%s", observed.ElapsedSeconds, observed.BusinessHTTPDelta, observed.BusinessWSDelta, observed.OriginalWS, observed.WSID, reverse.State.PairID, reverse.State.AttemptID, reverse.State.Generation, reverse.State.RuntimeGeneration, windows.launch.PID, reverse.WorkspaceID, reverse.SessionID)
			t.Logf("application-idle-progress direction=windows-to-macos elapsedSeconds=%.6f businessHTTPDelta=%d businessWSDelta=%d originalWS=%t ws=%s pair=%s attempt=%s generation=%d runtimeGeneration=%d macRuntimePid=%d workspace=%s session=%s", localProof.ElapsedSeconds, localProof.BusinessHTTPDelta, localProof.BusinessWSDelta, localProof.OriginalWS, localProof.WSID, state.PairID, state.AttemptID, state.Generation, state.RuntimeGeneration, macPID, workspace.ID, session)
		case <-stream.done:
			stream.healthy(t)
			t.Fatal("original forward WS reader ended during application idle")
		case <-ctx.Done():
			t.Fatal("application idle did not reach its full requested real duration")
		}
	}
	// Seal both zero-traffic intervals before either browser sends its first
	// post-idle application request. Test-control HTTP is not gateway traffic.
	proof := browser.endIdle(t, idle, stream, config.ApplicationIdleSeconds)
	ended := recoveryCrossControl(t, ctx, config, "/reverse-idle-end")
	remote = recoveryRequireReverse(t, ended, "ready", windows.binding.Generation)
	remoteProof := remote.ApplicationIdle
	if remote.State != reverse.State || remote.WSID != reverse.WSID || remote.SessionID != reverse.SessionID || remote.WorkspaceID != reverse.WorkspaceID || remote.Readbacks <= reverse.Readbacks || !ended.RuntimeAlive || ended.RuntimePID != macPID || remoteProof == nil || remoteProof.ElapsedSeconds < float64(config.ApplicationIdleSeconds) || remoteProof.BusinessHTTPDelta != 0 || remoteProof.BusinessWSDelta != 0 || !remoteProof.OriginalWS || !remoteProof.SameCookie || remoteProof.WSID != reverse.WSID {
		t.Fatal("reverse application idle did not retain its silent original browser and runtime")
	}
	if recoveryEntry(t, ctx, core, f, state) != originalURL {
		t.Fatal("application idle moved the original forward gateway")
	}
	windows.assertRunning(t, ctx, core)
	browser.readbackExisting(t, ctx, workspace, session, stream)
	if browser.cookieDigest(t) != idle.cookie {
		t.Fatal("forward idle readback replaced the original cookie")
	}
	t.Logf("duplex-application-idle direction=mac-to-windows elapsedSeconds=%.6f businessHTTPDelta=%d businessWSDelta=%d originalWS=%t ws=%s pair=%s attempt=%s generation=%d workspace=%s session=%s", remoteProof.ElapsedSeconds, remoteProof.BusinessHTTPDelta, remoteProof.BusinessWSDelta, remoteProof.OriginalWS, remote.WSID, remote.State.PairID, remote.State.AttemptID, remote.State.Generation, remote.WorkspaceID, remote.SessionID)
	t.Logf("duplex-application-idle direction=windows-to-macos elapsedSeconds=%.6f businessHTTPDelta=%d businessWSDelta=%d originalWS=%t ws=%s pair=%s attempt=%s generation=%d workspace=%s session=%s", proof.ElapsedSeconds, proof.BusinessHTTPDelta, proof.BusinessWSDelta, proof.OriginalWS, proof.WSID, state.PairID, state.AttemptID, state.Generation, workspace.ID, session)
	return remote
}

func recoveryForwardFresh(t *testing.T, seen map[string]bool, state peersession.State) {
	t.Helper()
	if state.AttemptID == "" || seen[state.AttemptID] {
		t.Fatal("forward recovery reused an attempt from this scenario")
	}
	seen[state.AttemptID] = true
}

func recoveryRequireReverse(t *testing.T, answer recoveryCrossStatus, stage string, runtimeGeneration uint64) *recoveryReverseStatus {
	t.Helper()
	reverse := answer.Reverse
	if reverse == nil || !reverse.Opened || reverse.State.Stage != stage || reverse.State.AttemptID == "" || reverse.State.PairID == "" || reverse.State.Generation == 0 || reverse.State.RuntimeGeneration != runtimeGeneration || reverse.WorkspaceID == "" || reverse.SessionID == "" || reverse.WSID == "" || reverse.Readbacks == 0 {
		t.Fatal("Mac role did not return actual scoped reverse workbench evidence")
	}
	if stage == "connected" && reverse.State.Error != "p2p.runtime_unavailable" || stage == "ready" && reverse.State.Error != "" {
		t.Fatal("reverse direction lost the exact typed runtime refusal")
	}
	return reverse
}

func recoveryReverseAdvanced(t *testing.T, before, after *recoveryReverseStatus) {
	t.Helper()
	if before.State.AttemptID == after.State.AttemptID || after.State.Generation <= before.State.Generation || before.State.PairID != after.State.PairID || before.WorkspaceID != after.WorkspaceID || before.SessionID != after.SessionID {
		t.Fatal("reverse replacement reused a stale attempt or changed the original session")
	}
}

func recoveryReverseUnchanged(t *testing.T, ctx context.Context, config recoveryCrossConfig, before *recoveryReverseStatus, interrupted string) *recoveryReverseStatus {
	t.Helper()
	after := recoveryRequireReverse(t, recoveryCrossControl(t, ctx, config, "/reverse-readback"), "ready", before.State.RuntimeGeneration)
	if after.State != before.State || after.WSID != before.WSID || after.Readbacks <= before.Readbacks || after.WorkspaceID != before.WorkspaceID || after.SessionID != before.SessionID {
		t.Fatal("opposite-direction cleanup disturbed the original Mac HTTP/session/WS attachment")
	}
	t.Logf("duplex-unaffected direction=mac-to-windows interrupted=%s pair=%s attempt=%s generation=%d originalWS=%s sameCookieSession=true", interrupted, after.State.PairID, after.State.AttemptID, after.State.Generation, after.WSID)
	return after
}

func recoveryForwardUnchanged(t *testing.T, ctx context.Context, core *localrpc.Peer, f *realCoordinator, browser *recoveryBrowser, workspace recoveryWorkspace, session string, stream *recoveryWS, state peersession.State, originalURL, interrupted string) {
	t.Helper()
	if recoveryEntry(t, ctx, core, f, state) != originalURL {
		t.Fatal("reverse cleanup moved the unaffected Windows gateway")
	}
	browser.readbackExisting(t, ctx, workspace, session, stream)
	t.Logf("duplex-unaffected direction=windows-to-macos interrupted=%s pair=%s attempt=%s generation=%d originalWS=true sameCookieSession=true", interrupted, state.PairID, state.AttemptID, state.Generation)
}
