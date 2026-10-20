//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// HANDLE lifetime, not a later PID lookup, owns both the injection and cleanup.
type recoveryExactProcess interface {
	Proof() recoveryProcessProof
	Alive() (bool, error)
	Terminate(context.Context) error
	Close() error
}

type recoveryProcessProof struct {
	PID              int    `json:"pid"`
	ParentPID        int    `json:"parentPid"`
	Creation         uint64 `json:"creation"`
	ExecutableSHA256 string `json:"executableSha256"`
}

type recoveryCrashCatalog struct {
	Enabled  bool           `json:"enabled"`
	Revision string         `json:"revision"`
	Record   catalog.Record `json:"record"`
}

// Retain only whether the real core announced the exact restored credential.
// Catalog/directory rows alone cannot prove that the core restored its device.
type recoveryRestoreWitness struct {
	mu      sync.Mutex
	want    string
	partial string
	seen    bool
}

func (witness *recoveryRestoreWitness) Write(data []byte) (int, error) {
	witness.mu.Lock()
	defer witness.mu.Unlock()
	witness.partial += string(data)
	for {
		line, rest, found := strings.Cut(witness.partial, "\n")
		if !found {
			break
		}
		if strings.HasSuffix(strings.TrimSuffix(line, "\r"), witness.want) {
			witness.seen = true
		}
		witness.partial = rest
	}
	if len(witness.partial) > 4096 {
		witness.partial = ""
	}
	return len(data), nil
}

func (witness *recoveryRestoreWitness) observed() bool {
	witness.mu.Lock()
	defer witness.mu.Unlock()
	return witness.seen
}

func recoveryReadCrashIdentity(t *testing.T, ctx context.Context, core *localrpc.Peer, f *realCoordinator) recoveryCrashCatalog {
	t.Helper()
	var current recoveryCrashCatalog
	must(t, protocol.DecodeExact(callCore(t, ctx, core, "core.catalog_inspect", struct{}{}), &current))
	if !current.Enabled || current.Revision == "" || len(current.Record.Computers) != 1 || len(current.Record.Services) != 1 {
		t.Fatal("crash profile requires the exact persisted enabled catalog")
	}
	computer := current.Record.Computers[0]
	if computer.ServiceID != f.authority.ServiceID || computer.LocalDeviceID != f.config[0].Device.DeviceID || computer.RemoteDeviceID != f.config[1].Device.DeviceID || computer.PairID != f.config[1].Device.DeviceID || computer.PairState != "active" {
		t.Fatal("crash catalog changed its original service/device/pair identity")
	}
	var view helper.DirectoryView
	must(t, protocol.DecodeExact(recoveryCall(t, ctx, core, f, "directory.inspect", struct{}{}), &view))
	if view.ServiceID != f.authority.ServiceID {
		t.Fatal("restarted core did not restore its original service directory")
	}
	// Known=false is explicitly retained: this test never logs in or fabricates
	// a user-directory snapshot to repair a missing restore prerequisite.
	t.Logf("core-crash-identity service=%s localDevice=%s remoteDevice=%s pair=%s catalogRevision=%s directoryKnown=%t directoryRevision=%d", f.authority.ServiceID, computer.LocalDeviceID, computer.RemoteDeviceID, computer.PairID, current.Revision, view.Known, view.Revision)
	return current
}

func recoveryRestartCommand(previous *exec.Cmd) (*exec.Cmd, error) {
	if previous == nil || previous.Path == "" || len(previous.Args) < 2 || previous.Args[1] != "serve" || len(previous.Env) == 0 {
		return nil, errors.New("test.core_restart_command_missing")
	}
	command := exec.Command(previous.Path, previous.Args[1:]...)
	command.Args = append([]string(nil), previous.Args...)
	command.Env = append([]string(nil), previous.Env...)
	command.Dir = previous.Dir
	return command, nil
}

func recoveryJoinKilledCore(ctx context.Context, process *process) error {
	// Drain through actual close, not merely the buffered Wait value. launch's
	// later cleanup must observe closed done and must never Kill a reused PID.
	for {
		select {
		case _, open := <-process.done:
			if !open {
				return nil
			}
		case <-ctx.Done():
			return errors.New("test.killed_core_wait_not_joined")
		}
	}
}

func recoveryCoreCrashCase(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, owned recoveryOwnedCore, events chan peersession.State, owner *recoveryWindowsOwner, windows *recoveryWindowsRuntime, initial *recoveryReverseStatus, inputs recoveryWindowsInputs, macPID int) {
	t.Helper()
	recoveryEnableIntent(t, f, owned.Peer) // Persist catalog, not outbound workbench intent.
	before := recoveryReadCrashIdentity(t, ctx, owned.Peer, f)
	victim, err := recoveryHoldExactProcess(owned.Process.cmd.Process.Pid, os.Getpid(), owned.Binary)
	must(t, err)
	defer func() { must(t, victim.Close()) }()
	ownerConfig, err := recoveryOwnerConfiguration(owned.Process.cmd)
	must(t, err)
	ownerIdentity, err := runtimeowner.InspectIdentityForEnvironment(ownerConfig, owned.Process.cmd.Env)
	must(t, err)
	if owned.Owner == nil || ownerIdentity != owned.Owner.identity {
		t.Fatal("core crash owner changed after its initial strict teardown admission")
	}
	ownerProcess, err := recoveryHoldExactProcess(ownerIdentity.PID, owned.Process.cmd.Process.Pid, owned.Binary)
	must(t, err)
	must(t, recoveryAdmitOwnerIdentity(ownerIdentity, ownerIdentity.Config, ownerProcess.Proof(), owned.Process.cmd.Process.Pid))
	dsh, err := recoveryHoldExactProcess(windows.launch.PID, ownerIdentity.PID, inputs.node)
	must(t, err)
	var cleanupOnce sync.Once
	stopOwner := func(core *localrpc.Peer) {
		cleanupOnce.Do(func() {
			defer func() {
				if err := dsh.Close(); err != nil {
					t.Errorf("core-crash DSH handle close failed: %v", err)
				}
			}()
			defer func() {
				if err := ownerProcess.Close(); err != nil {
					t.Errorf("core-crash owner handle close failed: %v", err)
				}
			}()
			cleanup, cancel := context.WithTimeout(context.Background(), 35*time.Second)
			defer cancel()
			stopErr, shutdownErr := owned.Owner.stopThenClose(cleanup, func(ctx context.Context) error {
				err := recoveryStopOwnedRuntime(ctx, core, windows.launch, dsh)
				if err != nil {
					t.Errorf("core-crash production runtime.stop failed: %v", err)
				}
				return err
			}) // Owner teardown has a fresh bounded lifetime, never recovery.
			if shutdownErr != nil {
				t.Errorf("core-crash owner shutdown was not joined: %v", shutdownErr)
			}
			alive, err := dsh.Alive()
			if err != nil || alive {
				t.Errorf("core-crash DSH cleanup did not prove held child exited pid=%d alive=%t code=%v", windows.launch.PID, alive, err)
			} else if shutdownErr == nil && stopErr == nil {
				t.Logf("core-crash-runtime-cleanup pid=%d launch=%s exactHandle=true reaped=true via=production-runtime-stop ownerShutdownJoined=true normalCoreExitProven=false", windows.launch.PID, windows.launch.LaunchID)
			}
			ownerAlive, ownerErr := ownerProcess.Alive()
			if ownerErr != nil || ownerAlive {
				t.Errorf("core-crash original owner still alive after teardown pid=%d code=%v", ownerIdentity.PID, ownerErr)
			}
		})
	}
	windows.cleanup = func() { stopOwner(owner.core.Load()) }
	consoleBefore, err := recoveryReadConsole(ctx, owned.Peer)
	must(t, err)
	if consoleBefore.Cursor <= 0 || windows.launch.StartedAtUnix <= 0 || windows.launch.Directory == "" {
		t.Fatal("original runtime owner had no startup console/time/directory identity")
	}
	t.Logf("core-crash-owned core=%s runtime=%s runtimeLaunch=%s ownerPid=%d ownerCreation=%s ownerEpoch=%s consoleCursor=%d", recoveryJSON(t, victim.Proof()), recoveryJSON(t, dsh.Proof()), windows.launch.LaunchID, ownerIdentity.PID, ownerIdentity.Creation, ownerIdentity.Instance, consoleBefore.Cursor)
	armed := recoveryCrossControl(t, ctx, config, "/reverse-network-arm")
	if armed.Network == nil || armed.Network.Case != "core-crash" || !armed.Network.Armed || armed.Reverse == nil || armed.Reverse.State != initial.State || !armed.Network.SameCookie {
		t.Fatal("core crash did not arm its unique original Mac workbench")
	}
	command, err := recoveryRestartCommand(owned.Process.cmd)
	must(t, err)
	killedAt := time.Now()
	killContext, cancelKill := context.WithTimeout(ctx, 5*time.Second)
	defer cancelKill()
	if err := victim.Terminate(killContext); err != nil {
		t.Fatalf("core crash injection refused: %v", err)
	}
	must(t, recoveryJoinKilledCore(killContext, owned.Process))
	cancelKill()
	t.Logf("core-crash-injected injectionPerformed=true oldCorePid=%d exactIdentity=true waitJoined=true killedAt=%s", victim.Proof().PID, killedAt.UTC().Format(time.RFC3339Nano))
	owned.Peer.Close()
	witness := &recoveryRestoreWitness{want: "[p2p] restored device " + f.config[0].Device.DeviceID + " for service " + f.authority.ServiceID + " from the core's own credential"}
	command.Stderr = io.MultiWriter(os.Stderr, witness)
	startupDeadline := time.Now().Add(30 * time.Second)
	daemon := recoveryLaunchServe(t, command, windows.cleanup)
	for !witness.observed() {
		if !time.Now().Before(startupDeadline) {
			t.Fatal("restarted core never proved exact own-credential restore within startup 30s; no observer restore was sent")
		}
		time.Sleep(time.Millisecond)
	}
	parent := recoveryAttachCore(t, f, events, owner.call, owned.StateRoot, stopOwner)
	owner.core.Store(parent)
	// Readiness and restored identity are distinct prerequisite boundaries. No
	// configure/restore/connect/start is sent after the intentional crash.
	after := recoveryReadCrashIdentity(t, ctx, parent, f)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("core restart changed the original persisted catalog")
	}
	readyAt := time.Now()
	deadline, cancel := context.WithDeadline(ctx, readyAt.Add(25*time.Second))
	defer cancel()
	var latest peersession.State
	reported := false
	reportFailure := func() {
		if reported {
			return
		}
		reported = true
		t.Errorf("core-crash automatic recovery failed within 25s from restored readiness; injectionPerformed=true state=%s", recoveryJSON(t, latest))
		recoveryCrashFailureDiagnostics(t, ctx, config, parent, events, latest)
	}
	defer func() {
		if errors.Is(deadline.Err(), context.DeadlineExceeded) {
			reportFailure()
		}
	}()
	alive, aliveErr := dsh.Alive()
	view, present, statusErr := recoveryReadWindowsStatus(deadline, parent, recoveryWindowsSubject)
	bindingRaw, bindingErr := parent.Call(deadline, "core.runtime_binding", struct{}{})
	ownerAfter, identityErr := runtimeowner.InspectIdentityForEnvironment(ownerConfig, owned.Process.cmd.Env)
	consoleAfter, consoleErr := recoveryReadConsole(deadline, parent)
	var currentBinding runtimebridge.Binding
	if identityErr != nil || ownerAfter != ownerIdentity || statusErr != nil || !present || view.PID != windows.launch.PID || view.LaunchID != windows.launch.LaunchID || view.SubjectID != windows.launch.SubjectID || view.StartedAtUnix != windows.launch.StartedAtUnix || view.Directory != windows.launch.Directory || bindingErr != nil || protocol.DecodeExact(bindingRaw, &currentBinding) != nil || currentBinding != windows.binding || consoleErr != nil || !recoverySameConsole(consoleBefore, consoleAfter) {
		t.Errorf("core-crash original runtime-owner continuity failed ownerIdentityError=%v runtimeStatusPresent=%t runtimeStatusError=%v runtimeBindingError=%v consoleError=%v consoleBefore=%d consoleAfter=%d", identityErr, present, statusErr, bindingErr, consoleErr, consoleBefore.Cursor, consoleAfter.Cursor)
	}
	t.Logf("core-crash-runtime-owner ownerPid=%d ownerEpoch=%s originalRuntimePid=%d runtimeGeneration=%d consoleBefore=%d consoleAfter=%d runtimeStatusPresent=%t", ownerAfter.PID, ownerAfter.Instance, view.PID, currentBinding.Generation, consoleBefore.Cursor, consoleAfter.Cursor, present)
	t.Logf("core-crash-restarted newCorePid=%d processGeneration=2 sameArgsEnv=true sameRoots=true identityRestored=true credentialRestoreObserved=true originalRuntimePid=%d originalRuntimeAlive=%t runtimeStatusPresent=%t runtimeStatusState=%s runtimeStatusError=%v runtimeBindingError=%v readyAt=%s restartMilliseconds=%d", daemon.cmd.Process.Pid, windows.launch.PID, alive, present, view.State, statusErr, bindingErr, readyAt.UTC().Format(time.RFC3339Nano), time.Since(killedAt).Milliseconds())
	if aliveErr != nil || !alive {
		t.Errorf("core crash lost its original real DSH pid=%d alive=%t code=%v", windows.launch.PID, alive, aliveErr)
	}
	for deadline.Err() == nil {
		answer, err := recoveryNetworkControl(deadline, config, "/reverse-network-state")
		if err != nil {
			if deadline.Err() != nil {
				break
			}
			t.Fatalf("core crash state observation failed: %v", err)
		}
		if answer.Network == nil || answer.Reverse == nil || answer.Network.Case != "core-crash" || !answer.Network.Armed {
			t.Fatal("core crash lost original Mac automatic owner")
		}
		latest = answer.Reverse.State
		if latest.Stage == "ready" && latest.AttemptID != initial.State.AttemptID && latest.Generation > initial.State.Generation {
			recoveryAcceptCoreCrash(t, deadline, ctx, config, parent, windows, owner, dsh, initial, answer, macPID, readyAt)
			return
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-deadline.Done():
		}
	}
	// Lock first failure before stack/current-state and natural retry observation.
	reportFailure()
	t.FailNow()
}

func recoveryCrashFailureDiagnostics(t *testing.T, ctx context.Context, config recoveryCrossConfig, core *localrpc.Peer, events <-chan peersession.State, latest peersession.State) {
	t.Helper()
	observation, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	scope := recoveryDiagnosticScope{ServiceID: config.Dialer.Authority.ServiceID, PairID: config.Remote.DeviceID, AttemptID: latest.AttemptID, Generation: latest.Generation}
	t.Log("core-crash-post-failure-observation acceptance=false maxExtra=45s noManualReconnect=true")
	recoveryCrossCollectStack(t, observation, config, scope)
	recoveryCoreCurrentDiagnostic(t, observation, core, scope)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case state := <-events:
			t.Logf("core-crash-post-failure-windows acceptance=false state=%s", recoveryJSON(t, state))
		case <-ticker.C:
			answer, err := recoveryNetworkControl(observation, config, "/reverse-network-state")
			if err != nil {
				t.Logf("core-crash-post-failure-mac acceptance=false observationError=%v", err)
			} else if answer.Reverse != nil && answer.Network != nil {
				t.Logf("core-crash-post-failure-mac acceptance=false engineAttempts=%d state=%s", answer.Network.EngineAttempts, recoveryJSON(t, answer.Reverse.State))
			}
		case <-observation.Done():
			t.Log("core-crash-post-failure-observation-ended acceptance=false")
			return
		}
	}
}

func recoveryAcceptCoreCrash(t *testing.T, acceptance, cleanup context.Context, config recoveryCrossConfig, parent *localrpc.Peer, windows *recoveryWindowsRuntime, owner *recoveryWindowsOwner, dsh recoveryExactProcess, initial *recoveryReverseStatus, state recoveryCrossStatus, macPID int, readyAt time.Time) {
	t.Helper()
	alive, err := dsh.Alive()
	must(t, err)
	if !alive {
		t.Fatal("core crash recovery replaced or lost the original DSH process")
	}
	view, present, err := recoveryReadWindowsStatus(acceptance, parent, recoveryWindowsSubject)
	must(t, err)
	if !present || view.PID != windows.launch.PID || view.LaunchID != windows.launch.LaunchID || windows.startCalls != 1 || owner.opens.Load() != 1 || state.Network.EngineAttempts == 0 {
		t.Fatal("core crash recovery did not retain exact production runtime ownership without a cold start")
	}
	windows.assertRunning(t, acceptance, parent)
	answer := recoveryCrossControl(t, acceptance, config, "/reverse-network-readback")
	if answer.Reverse == nil || answer.Network == nil || !answer.Network.ReadbackComplete || !answer.Network.SameCookie || answer.Network.OriginalWS || answer.Reverse.WorkspaceID != initial.WorkspaceID || answer.Reverse.SessionID != initial.SessionID || answer.Reverse.WSID == initial.WSID || !answer.RuntimeAlive || answer.RuntimePID != macPID {
		t.Fatal("core crash recovery lost original gateway/cookie/workspace/session identity")
	}
	if acceptance.Err() != nil || time.Since(readyAt) >= 25*time.Second {
		t.Fatal("core crash application readback exceeded unchanged 25s budget")
	}
	recoveryMilliseconds := time.Since(readyAt).Milliseconds()
	sealed := recoveryCrossControl(t, cleanup, config, "/reverse-seal")
	recoveryRequireSealed(t, sealed, answer.Reverse)
	finished := recoveryCrossControl(t, cleanup, config, "/finish")
	recoveryRequireSealed(t, finished, answer.Reverse)
	t.Logf("core-crash-completed injectionPerformed=true direction=mac-to-windows sameGateway=true sameCookieSession=true originalRuntime=true originalWS=false engineAttempts=%d noManualReconnect=true runtimeStarts=%d recoveryMilliseconds=%d windowsGatewayLifetime=terminated-with-old-core", answer.Network.EngineAttempts, windows.startCalls, recoveryMilliseconds)
}

func TestWorkbenchRecoveryCoreRestartCommand(t *testing.T) {
	if err := recoveryValidateCrossPhase("core-crash", ""); err != nil || recoveryScenarioLifetime(20, 43200, "core-crash", "") != 250*time.Second {
		t.Fatal("core crash must be one explicit independent phase, not a pressure or idle loop")
	}
	if err := recoveryValidateCrossPhase("core-crash", "short-inbound"); err == nil {
		t.Fatal("process crash cannot silently substitute a firewall injection")
	}
	old := exec.Command("candidate.exe", "serve", "--state", "owned-state", "--data", "owned-data")
	old.Env, old.Dir = []string{"DSH_HOME=owned-home", "PATH=explicit"}, "owned-working-directory"
	command, err := recoveryRestartCommand(old)
	if err != nil || !reflect.DeepEqual(command.Args, old.Args) || !reflect.DeepEqual(command.Env, old.Env) || command.Dir != old.Dir || command.Path != old.Path {
		t.Fatal("core restart must preserve exact original Args/Env/Dir/path without replaying initialization")
	}
	command.Env[0] = "changed"
	if old.Env[0] != "DSH_HOME=owned-home" {
		t.Fatal("restart command must not mutate original captured evidence")
	}
	if _, err := recoveryRestartCommand(exec.Command("candidate.exe", "call")); err == nil {
		t.Fatal("non-serve restart cannot select another entry point")
	}
	// The serialized ownership evidence is allowlisted, never command/environment.
	data, err := json.Marshal(recoveryProcessProof{PID: 1, ParentPID: 2, Creation: 3, ExecutableSHA256: "sentinel"})
	if err != nil || string(data) != `{"pid":1,"parentPid":2,"creation":3,"executableSha256":"sentinel"}` {
		t.Fatal("process identity proof must be serializable without command payload")
	}
}

func TestWorkbenchRecoveryCoreRestoreWitness(t *testing.T) {
	witness := &recoveryRestoreWitness{want: "[p2p] restored device sentinel-device for service sentinel-service from the core's own credential"}
	_, _ = witness.Write([]byte("timestamp [p2p] restored device wrong-device for service sentinel-service from the core's own credential\n"))
	if witness.observed() {
		t.Fatal("another device cannot prove the restarted candidate identity")
	}
	_, _ = witness.Write([]byte("timestamp [p2p] restored device sentinel-device for service "))
	if witness.observed() {
		t.Fatal("partial stderr cannot assert credential restoration")
	}
	_, _ = witness.Write([]byte("sentinel-service from the core's own credential\r\n"))
	if !witness.observed() {
		t.Fatal("complete exact production credential-restore evidence was not retained")
	}
}
