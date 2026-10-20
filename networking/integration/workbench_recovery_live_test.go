//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// This live gate uses a production coordinator process, an explicitly selected
// production core binary, production Pion sessions and an isolated actual DSH.
// It submits no model task and never restarts the user's existing DSH process.
func TestCoreWorkbenchRecoveryRealDSH(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	runtimeURL, runtimeProcess := startRealDSH(t)
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 150*time.Second)
	defer cancel()
	var remoteOwnerCalls, remoteResumeCalls, localOwnerCalls atomic.Int64
	var available atomic.Bool
	available.Store(true)
	remote := recoveryRemote(t, ctx, f, runtimeURL, &available, &remoteOwnerCalls, &remoteResumeCalls)
	defer func() { remote.Close() }()
	events := make(chan peersession.State, 4096)
	core := recoveryCore(t, f, events, &localOwnerCalls)
	pairID := f.config[1].Device.DeviceID
	var first peersession.Connected
	// The only explicit connect in this scenario. All following recovery belongs
	// to the core's catalog-driven automatic reconciliation engine.
	must(t, json.Unmarshal(recoveryCall(t, ctx, core, f, "peer.connect", map[string]any{
		"pairId": pairID, "generation": uint64(1), "requestWorkbench": true,
	}), &first))
	if first.State.Stage != "ready" || first.State.PairID != pairID || first.State.AttemptID == "" || first.State.RuntimeGeneration != 1 {
		t.Fatalf("initial workbench identity = %s", recoveryJSON(t, first.State))
	}
	recoveryEnableIntent(t, f, core)
	browser := recoveryOpenBrowser(t, ctx, first.URL)
	project, err := filepath.EvalSymlinks(runtimeProcess.cmd.Dir)
	must(t, err)
	workspace, sessionID := browser.createSession(t, ctx, project)
	stream := browser.readback(t, ctx, workspace, sessionID)
	previous := first.State
	attempts := map[string]bool{previous.AttemptID: true}
	for cycle := 1; cycle <= 3; cycle++ {
		// Closing this test-owned remote manager kills the real active transport.
		// The DSH process, its session, the initiator core and browser cookie live on.
		remote.Close()
		waitDisconnected(t, ctx, events, previous.AttemptID)
		browser.detached(t, ctx)
		assertRecoveryStreamClosed(t, ctx, stream)
		remote = recoveryRemote(t, ctx, f, runtimeURL, &available, &remoteOwnerCalls, &remoteResumeCalls)
		waitFixturePresence(t, f, 1, "online")
		current := recoveryState(t, ctx, events, pairID, previous.Generation, "ready")
		if attempts[current.AttemptID] || current.AttemptID == "" || current.RuntimeGeneration != previous.RuntimeGeneration || !directUDP(current.Path) {
			t.Fatalf("cycle %d selected stale/incorrect runtime identity: %s", cycle, recoveryJSON(t, current))
		}
		attempts[current.AttemptID] = true
		if recoveredURL := recoveryEntry(t, ctx, core, f, current); recoveredURL != first.URL {
			t.Fatalf("cycle %d moved the original authenticated gateway", cycle)
		}
		stream = browser.readback(t, ctx, workspace, sessionID)
		// Readback again after the previous attempt's asynchronous cleanup settled.
		settled := browser.readback(t, ctx, workspace, sessionID)
		settled.CloseNow()
		t.Logf("recovery-cycle cycle=%d service=%s pair=%s oldAttempt=%s attempt=%s generation=%d runtimeGeneration=%d sameGateway=true workspace=%s session=%s", cycle, f.authority.ServiceID, pairID, previous.AttemptID, current.AttemptID, current.Generation, current.RuntimeGeneration, workspace.ID, sessionID)
		previous = current
	}

	// Explicit disconnect clears only the workbench request. The existing catalog
	// may reconnect transport, but must never ask either runtime owner to start DSH.
	recoveryCall(t, ctx, core, f, "peer.disconnect", map[string]any{"pairId": pairID})
	browser.detached(t, ctx)
	assertRecoveryStreamClosed(t, ctx, stream)
	ownerCount := remoteOwnerCalls.Load()
	resumeCount := remoteResumeCalls.Load()
	if ownerCount != 1 || resumeCount != 3 {
		t.Fatalf("recovery used cold owner=%d resume owner=%d, want 1/3", ownerCount, resumeCount)
	}
	transport := recoveryState(t, ctx, events, pairID, previous.Generation, "connected")
	if transport.RuntimeGeneration != 0 || remoteOwnerCalls.Load() != ownerCount || remoteResumeCalls.Load() != resumeCount || localOwnerCalls.Load() != 0 {
		t.Fatalf("background transport activated a runtime: remote=%d -> %d local=%d state=%s", ownerCount, remoteOwnerCalls.Load(), localOwnerCalls.Load(), recoveryJSON(t, transport))
	}
	browser.detached(t, ctx)
	must(t, runtimebridge.Probe(ctx, runtimeURL))
	t.Logf("explicit-disconnect retained transport only service=%s pair=%s attempt=%s generation=%d ownerCalls=%d resumeCalls=%d", f.authority.ServiceID, pairID, transport.AttemptID, transport.Generation, ownerCount, resumeCount)

	// Actual server revocation closes the gateway, not the independently running DSH.
	must(t, f.client.DeleteNetwork(ctx, f.userSession.Token, f.config[0].Pin.Pair.NetworkID))
	recoveryCall(t, ctx, core, f, "network.invalidate", map[string]any{"networkId": f.config[0].Pin.Pair.NetworkID})
	assertGatewayClosed(t, ctx, first.URL)
	must(t, runtimebridge.Probe(ctx, runtimeURL))
	if remoteOwnerCalls.Load() != ownerCount || remoteResumeCalls.Load() != resumeCount || localOwnerCalls.Load() != 0 {
		t.Fatal("revocation activated a runtime owner")
	}
}

// An admitted explicit request retains its intent even if its first runtime
// binding refuses temporarily; a second explicit connect must not be needed.
func TestCoreWorkbenchFirstRefusalRecoveryRealDSH(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	runtimeURL, runtimeProcess := startRealDSH(t)
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 80*time.Second)
	defer cancel()
	var remoteOwnerCalls, remoteResumeCalls, localOwnerCalls atomic.Int64
	var available atomic.Bool
	remote := recoveryRemote(t, ctx, f, runtimeURL, &available, &remoteOwnerCalls, &remoteResumeCalls)
	defer remote.Close()
	events := make(chan peersession.State, 4096)
	core := recoveryCore(t, f, events, &localOwnerCalls)
	pairID := f.config[1].Device.DeviceID
	var first peersession.Connected
	must(t, json.Unmarshal(recoveryCall(t, ctx, core, f, "peer.connect", map[string]any{
		"pairId": pairID, "generation": uint64(1), "requestWorkbench": true,
	}), &first))
	if first.State.Stage != "connected" || first.State.Error != "runtime.worktree_invalid" || first.URL != "" || remoteOwnerCalls.Load() != 1 {
		t.Fatalf("first runtime refusal lost its exact state: %s ownerCalls=%d", recoveryJSON(t, first.State), remoteOwnerCalls.Load())
	}
	t.Logf("first-refusal-state %s", recoveryJSON(t, first.State))
	available.Store(true)
	recoveryEnableIntent(t, f, core)
	current := recoveryState(t, ctx, events, pairID, first.State.Generation, "ready")
	if current.AttemptID == first.State.AttemptID || current.RuntimeGeneration != 1 || localOwnerCalls.Load() != 0 || remoteOwnerCalls.Load() != 1 || remoteResumeCalls.Load() != 1 {
		t.Fatal("first-refusal retry did not establish the current requested runtime")
	}
	entry := recoveryEntry(t, ctx, core, f, current)
	browser := recoveryOpenBrowser(t, ctx, entry)
	project, err := filepath.EvalSymlinks(runtimeProcess.cmd.Dir)
	must(t, err)
	workspace, sessionID := browser.createSession(t, ctx, project)
	browser.readback(t, ctx, workspace, sessionID).CloseNow()
	t.Logf("first-refusal recovered service=%s pair=%s oldAttempt=%s attempt=%s generation=%d ownerCalls=%d", f.authority.ServiceID, pairID, first.State.AttemptID, current.AttemptID, current.Generation, remoteOwnerCalls.Load())
}

// Stopping the test-owned actual DSH models the user's explicit stop. Automatic
// recovery may inspect its running binding but cannot invoke the cold owner.
func TestCoreWorkbenchStoppedRuntimeStaysStoppedRealDSH(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	runtimeURL, runtimeProcess := startRealDSH(t)
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 80*time.Second)
	defer cancel()
	var coldCalls, resumeCalls, localCalls atomic.Int64
	var available atomic.Bool
	available.Store(true)
	remote := recoveryRemote(t, ctx, f, runtimeURL, &available, &coldCalls, &resumeCalls)
	defer remote.Close()
	events := make(chan peersession.State, 4096)
	core := recoveryCore(t, f, events, &localCalls)
	pairID := f.config[1].Device.DeviceID
	var initial peersession.Connected
	must(t, json.Unmarshal(recoveryCall(t, ctx, core, f, "peer.connect", map[string]any{
		"pairId": pairID, "generation": uint64(1), "requestWorkbench": true,
	}), &initial))
	if initial.State.Stage != "ready" || coldCalls.Load() != 1 || resumeCalls.Load() != 0 {
		t.Fatal("initial explicit open did not use exactly the cold owner")
	}
	recoveryEnableIntent(t, f, core)
	browser := recoveryOpenBrowser(t, ctx, initial.URL)
	pid := runtimeProcess.cmd.Process.Pid
	runtimeProcess.stop(t, false)
	available.Store(false)
	remote.InvalidateRuntime(1)
	waitDisconnected(t, ctx, events, initial.State.AttemptID)
	browser.detached(t, ctx)
	current := recoveryState(t, ctx, events, pairID, initial.State.Generation, "connected")
	if current.Error != "p2p.runtime_unavailable" || current.RuntimeGeneration != 0 || coldCalls.Load() != 1 || resumeCalls.Load() == 0 || localCalls.Load() != 0 || processRunning(pid) {
		t.Fatalf("automatic recovery restarted or misreported stopped DSH: state=%s cold=%d resume=%d local=%d originalPidAlive=%t", recoveryJSON(t, current), coldCalls.Load(), resumeCalls.Load(), localCalls.Load(), processRunning(pid))
	}
	browser.detached(t, ctx)
	recoveryCall(t, ctx, core, f, "peer.disconnect", map[string]any{"pairId": pairID})
	t.Logf("stopped-runtime remained stopped service=%s pair=%s attempt=%s generation=%d originalPid=%d coldCalls=%d resumeCalls=%d", f.authority.ServiceID, pairID, current.AttemptID, current.Generation, pid, coldCalls.Load(), resumeCalls.Load())
}

func recoveryRemote(t *testing.T, ctx context.Context, f *realCoordinator, runtimeURL string, available *atomic.Bool, calls, resumes *atomic.Int64) *peersession.Manager {
	t.Helper()
	return recoveryRemoteObserved(t, ctx, f, runtimeURL, available, calls, resumes, func(peersession.State) {}, func(string) {})
}

func recoveryRemoteObserved(t *testing.T, ctx context.Context, f *realCoordinator, runtimeURL string, available *atomic.Bool, calls, resumes *atomic.Int64, emit func(peersession.State), wake func(string)) *peersession.Manager {
	t.Helper()
	config := f.config[1]
	f.devices[1].SetAccount(config.Device.UserID)
	manager, err := peersession.New(ctx, f.devices[1], peersession.Config{
		Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device, PrivateKey: config.Private,
		CoreInstanceID: integrationCoreInstanceID(t), Wake: wake,
		ResumeOwner: func(context.Context, string) (runtimebridge.Binding, error) {
			resumes.Add(1)
			if !available.Load() {
				return runtimebridge.Binding{}, errors.New("p2p.runtime_unavailable")
			}
			return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
		},
	}, []controlplane.PairIdentity{}, func(context.Context, string) (runtimebridge.Binding, error) {
		calls.Add(1)
		if !available.Load() {
			return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
		}
		return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
	}, emit)
	must(t, err)
	integrationActivateManager(t, ctx, manager, f, 1)
	return manager
}

func assertRecoveryStreamClosed(t *testing.T, ctx context.Context, stream *recoveryWS) {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	stream.mu.Lock()
	stream.expectLoss = true
	stream.mu.Unlock()
	select {
	case <-stream.done:
		stream.mu.Lock()
		err, appError, localClose := stream.err, stream.appError, stream.localClose
		stream.mu.Unlock()
		if err == nil || appError || localClose {
			t.Fatalf("old runtime WS closure was not its remote transport loss ws=%s appError=%t localClose=%t", stream.id, appError, localClose)
		}
	case <-deadline.Done():
		t.Fatal("old runtime WS was not closed within five seconds of transport loss")
	}
}
