//go:build live && windows

package integration

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

func recoveryPauseRPC(t *testing.T, ctx context.Context, state string) (*localrpc.Peer, json.RawMessage) {
	t.Helper()
	record, err := localrpc.ReadEndpointRecord(filepath.Join(state, localrpc.EndpointFileName))
	must(t, err)
	connection, err := localrpc.Connect(ctx, record.Socket, record.Secret)
	must(t, err)
	peer := localrpc.New(ctx, connection, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("test.pause_unexpected_callback")
	})
	t.Cleanup(peer.Close)
	version, err := peer.Call(ctx, "core.version", struct{}{})
	must(t, err)
	must(t, recoveryPauseVersion(version))
	return peer, version
}

func recoveryPauseAwait(t *testing.T, ctx context.Context, root, name string, value any) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			t.Fatal(err)
		}
		if err := recoveryPauseRead(root, name, value); !os.IsNotExist(err) {
			must(t, err)
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
}

// Independent cleanup preflight. Killing the debugger is the ONLY release
// injection: this test never issues a manual second resume or debug detach.
func TestWorkbenchRecoveryPauseControllerCrashLive(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	binary := os.Getenv("DSHKER_TEST_CORE_BINARY")
	config := recoveryPauseCoreInputs(t, binary)
	core, owner := recoveryPauseStartOwnedCore(t, config)
	peer, before := recoveryPauseRPC(t, ctx, config.State)
	controller := recoveryStartProgramPause(t, ctx, binary, core.cmd.Process.Pid, os.Getpid())
	result := make(chan error, 1)
	go func() { _, err := controller.Pause(ctx, 35*time.Second); result <- err }()
	var paused recoveryPauseProof
	select {
	case paused = <-controller.paused:
	case err := <-result:
		t.Fatalf("test.pause_no_ack_before_controller_exit: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	controller.mu.Lock()
	run := controller.active
	controller.mu.Unlock()
	if run == nil || run.plan.ID != paused.ID || paused.ControllerPID == os.Getpid() || paused.CorePID != core.cmd.Process.Pid {
		t.Fatal("test.pause_crash_target_identity_invalid")
	}
	owned, err := recoveryPauseOpenExpected(run.plan.Controller, run.plan.TestBinary)
	must(t, err)
	defer owned.Close()
	stop, cancelStop := context.WithTimeout(ctx, 3*time.Second)
	must(t, owned.Terminate(stop))
	cancelStop()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("killed controller reported a full requested hold as PASS")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var proof recoveryPauseProof
	recoveryPauseAwait(t, ctx, run.plan.Root, "guard-result.json", &proof)
	if proof.ID != paused.ID || proof.CreationSHA != controller.core.Proof() || proof.ControllerPID != paused.ControllerPID || proof.PausedAt != paused.PausedAt || proof.ReleaseStartedAt.Before(paused.PausedAt) || proof.ReleasedAt.Before(proof.ReleaseStartedAt) || !proof.CleanupConfirmed || proof.Outcome != "detached" || proof.ErrorCode != "" || proof.GuardTerminatedController {
		t.Fatalf("test.pause_cleanup_failed: %+v", proof)
	}
	must(t, recoveryPauseAliveDetached(controller.core))
	after, err := peer.Call(ctx, "core.version", struct{}{})
	must(t, err)
	if !bytes.Equal(before, after) {
		t.Fatal("test.pause_original_core_rpc_identity_changed")
	}
	must(t, controller.Close(ctx))
	must(t, owner.closeBounded())
	t.Logf("program-pause-controller-crash proof=%s heldHandleAlive=true authenticatedRPC=true manualSecondResume=false firewallChanged=false networkChanged=false", recoveryJSON(t, proof))
}

type recoveryPauseOrphanReceipt struct {
	Core          recoveryProcessProof  `json:"core"`
	Runner        recoveryProcessProof  `json:"runner"`
	Owner         runtimeowner.Identity `json:"owner"`
	Pause         recoveryPauseProof    `json:"pause"`
	OperationRoot string                `json:"operationRoot"`
}

// This helper owns its fresh core, not the outer native test. Its forced death
// proves the guard does not depend on a defer, testing cleanup, parent pipe or
// a later manual second command from that owner.
func recoveryPauseOrphanRunner(root string) (resultErr error) {
	var config recoveryPauseOrphanConfig
	if err := recoveryPauseRead(root, "orphan-config.json", &config); err != nil {
		return err
	}
	if err := recoveryPauseScope(config.Binary, os.TempDir(), 2, 1); err != nil {
		return err
	}
	self, err := recoveryPauseSelf(config.TestBinary)
	if err != nil {
		return err
	}
	command, err := recoveryPauseCoreCommand(config)
	if err != nil {
		return err
	}
	recoveryPauseIndependentCommand(command)
	command.Stderr = os.Stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() { _ = command.Wait(); close(done) }()
	var core recoveryExactProcess
	var owner *recoveryOwnerTeardown
	captureAttempted := false
	handedOff := false
	defer func() {
		// Until the outer test holds this exact authority and acknowledges arm,
		// the child owns authenticated cleanup even on partial startup failure.
		if !handedOff {
			if owner == nil && !captureAttempted {
				captureAttempted = true
				owner, err = recoveryPauseCaptureOwner(command, command.Process.Pid, nil)
				resultErr = errors.Join(resultErr, err)
			}
			if owner != nil {
				resultErr = errors.Join(resultErr, owner.closeBounded())
			}
		} else if owner != nil {
			resultErr = errors.Join(resultErr, owner.held.Close())
		}
		stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if core != nil {
			if alive, aliveErr := core.Alive(); aliveErr != nil {
				resultErr = errors.Join(resultErr, aliveErr)
			} else if alive {
				resultErr = errors.Join(resultErr, core.Terminate(stop))
			}
			resultErr = errors.Join(resultErr, core.Close())
		} else {
			// The original exec.Cmd still owns its CreateProcess handle.
			resultErr = errors.Join(resultErr, command.Process.Kill())
		}
		select {
		case <-done:
		case <-stop.Done():
			resultErr = errors.Join(resultErr, errors.New("test.pause_orphan_core_wait_not_joined"))
		}
	}()
	original, err := recoveryHoldExactProcess(command.Process.Pid, os.Getpid(), config.Binary)
	if err != nil {
		return err
	}
	core, err = recoveryPauseTransferCore(original, config.Binary)
	if err != nil {
		return err
	}
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var announcement struct {
				Version int  `json:"version"`
				Serving bool `json:"serving"`
			}
			if json.Unmarshal(scanner.Bytes(), &announcement) == nil && announcement.Serving {
				ready <- announcement.Version == 1
				return
			}
		}
	}()
	select {
	case valid := <-ready:
		if !valid {
			return errors.New("test.pause_orphan_core_version_invalid")
		}
	case <-done:
		return errors.New("test.pause_orphan_core_exited")
	case <-time.After(20 * time.Second):
		return errors.New("test.pause_orphan_core_not_ready")
	}
	captureAttempted = true
	owner, err = recoveryPauseCaptureOwner(command, command.Process.Pid, nil)
	if err != nil {
		return err
	}
	receipt := recoveryPauseOrphanReceipt{Core: core.Proof(), Runner: self, Owner: owner.identity}
	if err := recoveryPauseWrite(root, "orphan-ready.json", receipt); err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var arm struct {
			ID string `json:"id"`
		}
		var held struct {
			ID    string                `json:"id"`
			Owner runtimeowner.Identity `json:"owner"`
		}
		if recoveryPauseRead(root, "orphan-owner-held.json", &held) == nil && held.ID == filepath.Base(root) && held.Owner == owner.identity {
			handedOff = true
		}
		if recoveryPauseRead(root, "orphan-cancel.json", &arm) == nil && arm.ID == filepath.Base(root) {
			return errors.New("test.pause_orphan_cancelled_before_arm")
		}
		if recoveryPauseRead(root, "orphan-arm.json", &arm) == nil && arm.ID == filepath.Base(root) {
			if !handedOff {
				return errors.New("test.pause_orphan_arm_without_owner_handoff")
			}
			break
		}
		if !time.Now().Before(deadline) {
			return errors.New("test.pause_orphan_never_armed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	controller := &recoveryPauseController{core: core, binary: config.Binary, testBinary: config.TestBinary, runner: self, paused: make(chan recoveryPauseProof, 1)}
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := controller.Pause(ctx, 35*time.Second); result <- err }()
	select {
	case receipt.Pause = <-controller.paused:
	case err := <-result:
		return errors.Join(err, errors.New("test.pause_orphan_no_pause_ack"))
	case <-ctx.Done():
		return ctx.Err()
	}
	controller.mu.Lock()
	receipt.OperationRoot = controller.active.plan.Root
	controller.mu.Unlock()
	if err := recoveryPauseWrite(root, "orphan-paused.json", receipt); err != nil {
		return err
	}
	return <-result // Outer test forcibly terminates this runner while held.
}

func TestWorkbenchRecoveryPauseParentGoneGuardLive(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 85*time.Second)
	defer cancel()
	binary := os.Getenv("DSHKER_TEST_CORE_BINARY")
	must(t, recoveryPauseScope(binary, os.TempDir(), 2, 1))
	must(t, recoveryPauseNativePrerequisites())
	testBinary, err := os.Executable()
	must(t, err)
	testBinary, err = filepath.EvalSymlinks(testBinary)
	must(t, err)
	root, err := os.MkdirTemp(os.TempDir(), "dshker-program-pause-parent-")
	must(t, err)
	config := recoveryPauseCoreInputs(t, binary)
	config.TestBinary = testBinary
	command, err := recoveryPauseCoreCommand(config)
	must(t, err)
	must(t, recoveryPauseWrite(root, "orphan-config.json", config))
	runner, err := recoveryPauseStartChild(testBinary, "pause-orphan-runner", root)
	must(t, err)
	armed := false
	defer func() {
		if !armed {
			// Before ownership handoff, let the original child authenticate and
			// close its own owner. This cleanup budget cannot admit a pause.
			if err := recoveryPauseWrite(root, "orphan-cancel.json", struct {
				ID string `json:"id"`
			}{ID: filepath.Base(root)}); err != nil {
				t.Errorf("test.pause_orphan_cancel_failed: %v", err)
			}
			select {
			case <-runner.done:
			case <-time.After(40 * time.Second):
				t.Error("test.pause_orphan_before_arm_cleanup_not_joined")
			}
		}
		stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if alive, err := runner.process.Alive(); err != nil {
			t.Errorf("test.pause_orphan_runner_cleanup_state_failed: %v", err)
		} else if alive {
			if err := runner.process.Terminate(stop); err != nil {
				t.Errorf("test.pause_orphan_runner_cleanup_failed: %v", err)
			}
		}
		select {
		case <-runner.done:
		case <-stop.Done():
			t.Error("test.pause_orphan_runner_wait_not_joined")
		}
		if err := runner.process.Close(); err != nil {
			t.Errorf("test.pause_orphan_runner_handle_close_failed: %v", err)
		}
	}()
	var ready recoveryPauseOrphanReceipt
	must(t, runner.waitReceipt(ctx, root, "orphan-ready.json", &ready))
	if ready.Runner != runner.process.Proof() || ready.Core.ParentPID != ready.Runner.PID {
		t.Fatal("test.pause_orphan_runner_identity_mismatch")
	}
	owner, err := recoveryPauseCaptureOwner(command, ready.Core.PID, &ready.Owner)
	must(t, err)
	ownerTransferred := false
	t.Cleanup(func() {
		if ownerTransferred {
			owner.finish(t)
		} else if err := owner.held.Close(); err != nil {
			t.Errorf("test.pause_untransferred_owner_handle_close_failed: %v", err)
		}
	})
	must(t, recoveryPauseWrite(root, "orphan-owner-held.json", struct {
		ID    string                `json:"id"`
		Owner runtimeowner.Identity `json:"owner"`
	}{ID: filepath.Base(root), Owner: owner.identity}))
	ownerTransferred = true
	core, err := recoveryPauseOpenExpected(ready.Core, binary)
	must(t, err)
	defer core.Close()
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		if alive, _ := core.Alive(); alive {
			if err := core.Terminate(stop); err != nil {
				t.Errorf("test.pause_orphan_core_cleanup_failed: %v", err)
			}
		}
	}()
	peer, before := recoveryPauseRPC(t, ctx, config.State)
	must(t, recoveryPauseWrite(root, "orphan-arm.json", struct {
		ID string `json:"id"`
	}{ID: filepath.Base(root)}))
	armed = true
	var paused recoveryPauseOrphanReceipt
	must(t, runner.waitReceipt(ctx, root, "orphan-paused.json", &paused))
	if paused.Core != ready.Core || paused.Runner != ready.Runner || paused.Owner != ready.Owner || paused.Pause.CreationSHA != ready.Core || paused.OperationRoot == "" || paused.Pause.PausedAt.IsZero() {
		t.Fatal("test.pause_orphan_pause_identity_mismatch")
	}
	stop, cancelStop := context.WithTimeout(ctx, 3*time.Second)
	must(t, runner.process.Terminate(stop))
	cancelStop()
	<-runner.done
	var proof recoveryPauseProof
	recoveryPauseAwait(t, ctx, paused.OperationRoot, "guard-result.json", &proof)
	if proof.ID != paused.Pause.ID || proof.CreationSHA != ready.Core || proof.ControllerPID != paused.Pause.ControllerPID || proof.PausedAt != paused.Pause.PausedAt || proof.Outcome != "detached" || !proof.CleanupConfirmed || proof.ErrorCode != "" || !proof.GuardTerminatedController {
		t.Fatalf("test.pause_cleanup_failed: %+v", proof)
	}
	must(t, recoveryPauseAliveDetached(core))
	after, err := peer.Call(ctx, "core.version", struct{}{})
	must(t, err)
	if !bytes.Equal(before, after) {
		t.Fatal("test.pause_parentgone_rpc_identity_changed")
	}
	must(t, owner.closeBounded())
	t.Logf("program-pause-parentgone proof=%s originalRunnerTerminated=true heldHandleAlive=true authenticatedRPC=true manualSecondResume=false firewallChanged=false networkChanged=false", recoveryJSON(t, proof))
}
