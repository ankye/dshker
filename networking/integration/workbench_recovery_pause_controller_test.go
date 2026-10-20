//go:build live

package integration

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type recoveryPauseController struct {
	mu         sync.Mutex
	core       recoveryExactProcess
	binary     string
	testBinary string
	runner     recoveryProcessProof
	active     *recoveryPauseRun
	closed     bool
	cleanupErr error
	paused     chan recoveryPauseProof
}

type recoveryPauseChild struct {
	command *exec.Cmd
	process recoveryExactProcess
	done    chan struct{}
	err     error // published by closing done
}

type recoveryPauseRun struct {
	plan       recoveryPausePlan
	controller *recoveryPauseChild
	guard      *recoveryPauseChild
	cancel     chan struct{}
	done       chan struct{}
	once       sync.Once
	err        error
	cleanupErr error
	hardUntil  time.Time // Parent-only monotonic deadline; never serialized.
}

func recoveryPauseTransferCore(original recoveryExactProcess, binary string) (recoveryExactProcess, error) {
	if original == nil {
		return nil, errors.New("test.pause_original_core_handle_required")
	}
	// Retain the original held object until the required-rights handle has
	// matched its PID, parent, creation and executable SHA. No PID-only reopen.
	required, err := recoveryPauseOpenExpected(original.Proof(), binary)
	if err != nil {
		return nil, errors.Join(err, original.Close())
	}
	if err := original.Close(); err != nil {
		return nil, errors.Join(err, required.Close())
	}
	return required, nil
}

func recoveryStartProgramPause(t *testing.T, ctx context.Context, binary string, pid, parent int) *recoveryPauseController {
	t.Helper()
	if err := ctx.Err(); err != nil {
		t.Fatal(err)
	}
	must(t, recoveryPauseScope(binary, os.TempDir(), pid, parent))
	must(t, recoveryPauseNativePrerequisites())
	if parent != os.Getpid() {
		t.Fatal("test.pause_requires_direct_owned_core")
	}
	testBinary, err := os.Executable()
	must(t, err)
	testBinary, err = filepath.EvalSymlinks(testBinary)
	must(t, err)
	runner, err := recoveryPauseSelf(testBinary)
	must(t, err)
	original, err := recoveryHoldExactProcess(pid, parent, binary)
	must(t, err)
	core, err := recoveryPauseTransferCore(original, binary)
	must(t, err)
	controller := &recoveryPauseController{core: core, binary: binary, testBinary: testBinary, runner: runner, paused: make(chan recoveryPauseProof, 1)}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := controller.Close(cleanup); err != nil {
			t.Errorf("test.pause_cleanup_failed: %v", err)
		}
	})
	return controller
}

func recoveryPauseStartChild(binary, mode, root string) (*recoveryPauseChild, error) {
	command := exec.Command(binary, "-test.run=^TestWorkbenchRecoveryPauseHelperProcess$", "--", mode, root)
	recoveryPauseIndependentCommand(command)
	command.Stdout, command.Stderr = os.Stderr, os.Stderr
	if err := command.Start(); err != nil {
		return nil, errors.New("test.pause_helper_start_failed")
	}
	child := &recoveryPauseChild{command: command, done: make(chan struct{})}
	go func() { child.err = command.Wait(); close(child.done) }()
	process, err := recoveryHoldExactProcess(command.Process.Pid, os.Getpid(), binary)
	if err != nil {
		// exec.Cmd still owns the exact CreateProcess handle, not a fresh PID.
		_ = command.Process.Kill()
		<-child.done
		return nil, err
	}
	child.process = process
	return child, nil
}

func (controller *recoveryPauseController) Pause(ctx context.Context, duration time.Duration) (recoveryPauseProof, error) {
	controller.mu.Lock()
	if controller.closed || controller.active != nil || (duration != 3*time.Second && duration != 35*time.Second) {
		controller.mu.Unlock()
		return recoveryPauseProof{}, errors.New("test.pause_invalid_or_overlapping_operation")
	}
	if err := ctx.Err(); err != nil {
		controller.mu.Unlock()
		return recoveryPauseProof{}, err
	}
	select {
	case <-controller.paused: // A prior observational ack never belongs to this nonce.
	default:
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		controller.mu.Unlock()
		return recoveryPauseProof{}, err
	}
	root, err := os.MkdirTemp(os.TempDir(), "dshker-program-pause-")
	if err != nil {
		controller.mu.Unlock()
		return recoveryPauseProof{}, err
	}
	createdTick, err := recoveryPauseTickMilliseconds()
	if err != nil {
		controller.mu.Unlock()
		return recoveryPauseProof{}, err
	}
	createdClock := time.Now()
	created := createdClock.UTC()
	deadline := createdClock.Add(duration + 15*time.Second)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	lifetime := deadline.Sub(createdClock)
	if lifetime < duration+5*time.Second {
		controller.mu.Unlock()
		return recoveryPauseProof{}, errors.New("test.pause_insufficient_guard_lifetime")
	}
	hardUntil := deadline
	run := &recoveryPauseRun{plan: recoveryPausePlan{ID: hex.EncodeToString(nonce), Root: root, Binary: controller.binary, TestBinary: controller.testBinary, Core: controller.core.Proof(), Runner: controller.runner, CreatedAt: created, Deadline: deadline, CreatedTickMilliseconds: createdTick, DeadlineTickMilliseconds: createdTick + uint64(lifetime.Milliseconds()), HeldMillis: duration.Milliseconds()}, cancel: make(chan struct{}), done: make(chan struct{})}
	run.plan.Deadline = deadline.UTC()
	run.hardUntil = hardUntil
	controller.active = run
	controller.mu.Unlock()
	proof, operationErr := controller.execute(ctx, run)
	controller.mu.Lock()
	run.err = operationErr
	controller.cleanupErr = errors.Join(controller.cleanupErr, run.cleanupErr)
	controller.active = nil
	close(run.done)
	controller.mu.Unlock()
	return proof, operationErr
}

func (controller *recoveryPauseController) execute(ctx context.Context, run *recoveryPauseRun) (proof recoveryPauseProof, result error) {
	// A helper has no authority until the plan, independently held guard handles,
	// ready receipt and final arm receipt have all been validated.
	var err error
	run.controller, err = recoveryPauseStartChild(controller.testBinary, "pause-controller", run.plan.Root)
	if err != nil {
		return proof, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		run.cleanupErr = run.finish(cleanup)
		result = errors.Join(result, run.cleanupErr)
	}()
	run.plan.Controller = run.controller.process.Proof()
	if err := run.plan.validate(time.Now().UTC()); err != nil {
		return proof, err
	}
	if err := recoveryPauseWrite(run.plan.Root, "plan.json", run.plan); err != nil {
		return proof, err
	}
	run.guard, err = recoveryPauseStartChild(controller.testBinary, "pause-guard", run.plan.Root)
	if err != nil {
		return proof, err
	}
	var ready recoveryPauseReady
	if err := run.waitFile(ctx, "guard-ready.json", &ready); err != nil {
		return proof, err
	}
	if err := run.plan.acceptReady(ready, time.Now().UTC()); err != nil || ready.Guard != run.guard.process.Proof() {
		return proof, errors.New("test.pause_guard_not_exact_ready")
	}
	if err := recoveryPauseWrite(run.plan.Root, "armed.json", ready); err != nil {
		return proof, err
	}
	if err := run.waitFile(ctx, "paused.json", &proof); err != nil {
		return proof, err
	}
	if proof.ID != run.plan.ID || proof.CreationSHA != run.plan.Core || proof.CorePID != run.plan.Core.PID || proof.ControllerPID != run.plan.Controller.PID || !proof.IdentityVerified || proof.PausedAt.Before(run.plan.CreatedAt) || proof.PausedAt.After(time.Now().UTC()) {
		return proof, errors.New("test.pause_paused_ack_mismatch")
	}
	select {
	case controller.paused <- proof:
	default:
		return proof, errors.New("test.pause_unconsumed_prior_ack")
	}
	if err := run.waitFile(ctx, "controller-result.json", &proof); err != nil {
		return proof, err
	}
	var guardProof recoveryPauseProof
	if err := run.waitFile(ctx, "guard-result.json", &guardProof); err != nil {
		return proof, err
	}
	if guardProof != proof {
		return guardProof, errors.New("test.pause_guard_result_mismatch")
	}
	if !time.Now().Before(run.hardUntil) {
		return proof, errors.New("test.pause_guard_deadline_expired")
	}
	ledger := recoveryPauseReceiptLedger{}
	return proof, ledger.accept(run.plan, proof, time.Now().UTC())
}

func (run *recoveryPauseRun) waitFile(ctx context.Context, name string, value any) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !time.Now().Before(run.hardUntil) {
			return errors.New("test.pause_guard_deadline_expired")
		}
		if err := recoveryPauseRead(run.plan.Root, name, value); !os.IsNotExist(err) {
			return err
		}
		if name != "guard-result.json" {
			var cleanup recoveryPauseProof
			if recoveryPauseRead(run.plan.Root, "guard-result.json", &cleanup) == nil {
				return errors.New("test.pause_controller_exited_before_normal_release")
			}
		}
		select {
		case <-run.cancel:
			return errors.New("test.pause_controller_closed")
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (run *recoveryPauseRun) finish(ctx context.Context) error {
	// Release requests only shorten a failed operation; no partial hold is PASS.
	_ = recoveryPauseWrite(run.plan.Root, "release.json", map[string]string{"id": run.plan.ID})
	var result error
	for _, child := range []*recoveryPauseChild{run.controller, run.guard} {
		if child == nil {
			continue
		}
		select {
		case <-child.done:
		case <-ctx.Done():
			// Never kill the guard. It retains the core handle and hard deadline
			// if this runner has lost the ability to confirm cleanup.
			if child == run.controller {
				kill, cancel := context.WithTimeout(context.Background(), time.Second)
				result = errors.Join(result, child.process.Terminate(kill))
				cancel()
				select {
				case <-child.done:
				case <-time.After(time.Second):
					result = errors.Join(result, errors.New("test.pause_controller_wait_not_joined"))
				}
			}
			result = errors.Join(result, errors.New("test.pause_helper_join_failed"))
		}
		result = errors.Join(result, child.process.Close())
	}
	if run.guard != nil {
		var proof recoveryPauseProof
		if err := recoveryPauseRead(run.plan.Root, "guard-result.json", &proof); err != nil || !proof.CleanupConfirmed || proof.Outcome == "terminated" || proof.ErrorCode != "" {
			result = errors.Join(result, errors.New("test.pause_cleanup_failed"))
		}
	}
	return result
}

func (controller *recoveryPauseController) Close(ctx context.Context) error {
	controller.mu.Lock()
	controller.closed = true
	run := controller.active
	if run != nil {
		run.once.Do(func() { close(run.cancel) })
	}
	controller.mu.Unlock()
	if run != nil {
		select {
		case <-run.done:
		case <-ctx.Done():
			return errors.New("test.pause_cleanup_failed")
		}
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.core == nil {
		return controller.cleanupErr
	}
	confirmed := recoveryPauseConfirmUnpaused(controller.core)
	closeErr := controller.core.Close()
	controller.core = nil
	if confirmed != nil {
		return errors.Join(controller.cleanupErr, confirmed, closeErr, errors.New("test.pause_cleanup_failed"))
	}
	return errors.Join(controller.cleanupErr, closeErr)
}

// Only a test binary includes this entry. No production flag, IPC operation,
// helper mode, runtime switch or packaged resource is introduced.
func TestWorkbenchRecoveryPauseHelperProcess(t *testing.T) {
	if len(os.Args) < 4 || os.Args[len(os.Args)-3] != "--" {
		return
	}
	mode, root := os.Args[len(os.Args)-2], os.Args[len(os.Args)-1]
	if mode != "pause-controller" && mode != "pause-guard" && mode != "pause-orphan-runner" {
		return
	}
	if err := recoveryPauseHelper(mode, root); err != nil {
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(2)
	}
	os.Exit(0)
}
