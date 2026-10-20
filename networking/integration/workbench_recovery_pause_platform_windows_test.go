//go:build live && windows

package integration

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Documented Win32 debugging only; never thread enumeration/suspension, memory
// or register access, privilege adjustment, Nt APIs, shell tools or policies.
// https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-debugactiveprocess
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-debugsetprocesskillonexit
// https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent
// https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-debugactiveprocessstop
var recoveryPauseKernel = windows.NewLazySystemDLL("kernel32.dll")
var recoveryPauseAttach = recoveryPauseKernel.NewProc("DebugActiveProcess")
var recoveryPauseKillOnExit = recoveryPauseKernel.NewProc("DebugSetProcessKillOnExit")
var recoveryPauseWait = recoveryPauseKernel.NewProc("WaitForDebugEvent")
var recoveryPauseContinue = recoveryPauseKernel.NewProc("ContinueDebugEvent")
var recoveryPauseDetach = recoveryPauseKernel.NewProc("DebugActiveProcessStop")
var recoveryPauseCheck = recoveryPauseKernel.NewProc("CheckRemoteDebuggerPresent")
var recoveryPauseGetTick = recoveryPauseKernel.NewProc("GetTickCount64")

// Win64 SDK DEBUG_EVENT: three DWORDs, 4-byte alignment padding, then the
// 160-byte EXCEPTION_DEBUG_INFO-sized union. Both admitted Windows targets use
// this ABI. A 32-bit target is a typed prerequisite failure, not a guessed ABI.
type recoveryPauseDebugEvent struct {
	Code, PID, Thread uint32
	Padding           uint32
	Union             [20]uint64
}

func recoveryPauseNativePrerequisites() error {
	if (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") || unsafe.Sizeof(recoveryPauseDebugEvent{}) != 176 {
		return errors.New("test.pause_debug_abi_unavailable")
	}
	for _, proc := range []*windows.LazyProc{recoveryPauseAttach, recoveryPauseKillOnExit, recoveryPauseWait, recoveryPauseContinue, recoveryPauseDetach, recoveryPauseCheck, recoveryPauseGetTick} {
		if proc.Find() != nil {
			return errors.New("test.pause_debug_api_unavailable")
		}
	}
	return nil
}

// GetTickCount64 is machine uptime, independent of wall-clock adjustments.
// https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64
func recoveryPauseTickMilliseconds() (uint64, error) {
	if (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") || recoveryPauseGetTick.Find() != nil {
		return 0, errors.New("test.pause_monotonic_tick_unavailable")
	}
	tick, _, _ := recoveryPauseGetTick.Call()
	if tick == 0 {
		return 0, errors.New("test.pause_monotonic_tick_unavailable")
	}
	return uint64(tick), nil
}

func recoveryPauseIndependentCommand(command *exec.Cmd) {
	// No job-policy or privileged breakaway change. If the runner's enclosing
	// job also kills the guard, that native cleanup proof must fail explicitly.
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

func recoveryPauseSelf(binary string) (recoveryProcessProof, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(os.Getpid()))
	if err != nil {
		return recoveryProcessProof{}, errors.New("test.pause_runner_handle_unavailable")
	}
	defer windows.CloseHandle(handle)
	process := &recoveryWindowsProcess{handle: handle, executable: binary}
	return process.inspect(os.Getpid())
}

func recoveryPauseOpenExpected(proof recoveryProcessProof, binary string) (recoveryExactProcess, error) {
	if !recoveryPauseValidIdentity(proof) || proof.PID == os.Getpid() {
		return nil, errors.New("test.pause_required_query_identity_invalid")
	}
	canonical, err := filepath.EvalSymlinks(binary)
	if err != nil || !strings.EqualFold(canonical, binary) {
		return nil, errors.New("test.pause_executable_not_canonical")
	}
	// The single same-core native diagnostic is preserved in
	// .run/open-workbench-recovery/d19-native-rights-diagnostic-20261020/windows-native.log:
	// LIMITED query returned Win32 5; explicit QUERY_INFORMATION succeeded.
	// These are this pause profile's required rights, never a failed-call retry.
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(proof.PID))
	if err != nil {
		return nil, errors.Join(errors.New("test.pause_required_query_handle_unavailable"), err)
	}
	process := &recoveryWindowsProcess{handle: handle, executable: binary}
	observed, err := process.inspect(proof.PID)
	if err != nil {
		return nil, errors.Join(err, process.Close())
	}
	if err := recoveryPauseRequireSameIdentity(proof, observed); err != nil {
		return nil, errors.Join(err, process.Close())
	}
	process.proof = observed
	if alive, err := process.Alive(); err != nil || !alive {
		return nil, errors.Join(errors.New("test.pause_required_query_process_not_alive"), err, process.Close())
	}
	return process, nil
}

func recoveryPauseObserveRunner(proof recoveryProcessProof, binary string) (recoveryExactProcess, error) {
	// Guard never terminates the runner, so it does not request that authority.
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(proof.PID))
	if err != nil {
		return nil, errors.New("test.pause_runner_observation_unavailable")
	}
	process := &recoveryWindowsProcess{handle: handle, executable: binary}
	current, err := process.inspect(proof.PID)
	if err != nil || current != proof {
		windows.CloseHandle(handle)
		return nil, errors.New("test.pause_runner_observation_mismatch")
	}
	process.proof = current
	return process, nil
}

func recoveryPauseObserveDebugger(process recoveryExactProcess) (recoveryPauseDebuggerObservation, error) {
	held, ok := process.(*recoveryWindowsProcess)
	if !ok {
		return recoveryPauseDebuggerObservation{}, errors.New("test.pause_requires_stable_windows_handle")
	}
	var present uint32
	value, _, nativeError := recoveryPauseCheck.Call(uintptr(held.handle), uintptr(unsafe.Pointer(&present)))
	if value != 0 {
		return recoveryPauseDebuggerResult(value, present, 0)
	}
	var errno syscall.Errno
	if nativeError != nil && !errors.As(nativeError, &errno) {
		return recoveryPauseDebuggerObservation{}, errors.Join(errors.New("test.pause_debug_state_unavailable_without_win32_error"), nativeError)
	}
	return recoveryPauseDebuggerResult(value, present, uint32(errno))
}

func recoveryPauseDebugged(process recoveryExactProcess) (bool, error) {
	observation, err := recoveryPauseObserveDebugger(process)
	return observation.DebuggerPresent, err
}

func recoveryPauseAliveDetached(process recoveryExactProcess) error {
	alive, err := process.Alive()
	if err != nil || !alive {
		return errors.New("test.pause_core_not_alive")
	}
	debugged, err := recoveryPauseDebugged(process)
	if err != nil {
		return err
	}
	if debugged {
		return errors.New("test.pause_core_still_debugged")
	}
	return nil
}

func recoveryPauseConfirmUnpaused(process recoveryExactProcess) error {
	return recoveryPauseAliveDetached(process)
}

func recoveryPauseHelper(mode, root string) error {
	if err := recoveryPauseNativePrerequisites(); err != nil {
		return err
	}
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || filepath.Dir(root) != filepath.Clean(os.TempDir()) {
		return errors.New("test.pause_helper_root_invalid")
	}
	if mode == "pause-orphan-runner" {
		return recoveryPauseOrphanRunner(root)
	}
	// Controller is deliberately started unarmed; it waits for the parent to
	// capture its exact CreateProcess identity and publish the immutable plan.
	deadline := time.Now().Add(8 * time.Second)
	var plan recoveryPausePlan
	for {
		err := recoveryPauseRead(root, "plan.json", &plan)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) || !time.Now().Before(deadline) {
			return errors.New("test.pause_helper_plan_unavailable")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if plan.Root != root {
		return errors.New("test.pause_helper_plan_root_mismatch")
	}
	if err := plan.validate(time.Now().UTC()); err != nil {
		return err
	}
	if mode == "pause-guard" {
		return recoveryPauseRunGuard(plan)
	}
	return recoveryPauseRunDebugger(plan)
}

func recoveryPauseRunDebugger(plan recoveryPausePlan) error {
	anchor := time.Now()
	tick, err := recoveryPauseTickMilliseconds()
	if err != nil {
		return err
	}
	remaining, err := plan.remainingAt(tick)
	if err != nil {
		return err
	}
	hardUntil := anchor.Add(remaining)
	self, err := recoveryPauseSelf(plan.TestBinary)
	if err != nil || self != plan.Controller {
		return errors.New("test.pause_controller_identity_mismatch")
	}
	core, err := recoveryPauseOpenExpected(plan.Core, plan.Binary)
	if err != nil {
		return err
	}
	defer core.Close()
	runner, err := recoveryPauseObserveRunner(plan.Runner, plan.TestBinary)
	if err != nil {
		return err
	}
	defer runner.Close()
	var ready recoveryPauseReady
	for {
		if !time.Now().Add(time.Duration(plan.HeldMillis)*time.Millisecond + 2*time.Second).Before(hardUntil) {
			return errors.New("test.pause_guard_lifetime_expired_before_attach")
		}
		if err := recoveryPauseRead(plan.Root, "armed.json", &ready); err == nil {
			break
		} else if !os.IsNotExist(err) {
			return err
		}
		alive, err := runner.Alive()
		if err != nil || !alive || recoveryPauseReleaseRequested(plan) {
			return errors.New("test.pause_runner_lost_before_attach")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := plan.acceptReady(ready, time.Now().UTC()); err != nil {
		return err
	}
	guard, err := recoveryPauseOpenExpected(ready.Guard, plan.TestBinary)
	if err != nil {
		return err
	}
	defer guard.Close()
	if alive, err := guard.Alive(); err != nil || !alive {
		return errors.New("test.pause_independent_guard_not_alive")
	}
	if err := recoveryPauseAliveDetached(core); err != nil {
		return err // Never attach to an already debugged process.
	}
	// Debug connection and event ownership are bound to this exact OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	attached, _, _ := recoveryPauseAttach.Call(uintptr(plan.Core.PID))
	if attached == 0 {
		return errors.New("test.pause_debug_attach_access_denied")
	}
	// Win32 forbids this before a debug connection. The tiny default-kill
	// interval is unavoidable and is never claimed to be risk-free; the guard
	// records terminated/cleanup_failed if this debugger dies in that interval.
	safeExit, _, _ := recoveryPauseKillOnExit.Call(0)
	if safeExit == 0 {
		recoveryPauseDetach.Call(uintptr(plan.Core.PID))
		return errors.New("test.pause_debug_kill_on_exit_disable_failed")
	}
	var event recoveryPauseDebugEvent
	for {
		ok, _, _ := recoveryPauseWait.Call(uintptr(unsafe.Pointer(&event)), 50)
		if ok != 0 {
			break
		}
		if recoveryPauseReleaseRequested(plan) || !time.Now().Add(time.Duration(plan.HeldMillis)*time.Millisecond+time.Second).Before(hardUntil) {
			recoveryPauseDetach.Call(uintptr(plan.Core.PID))
			return errors.New("test.pause_debug_event_not_observed")
		}
	}
	if event.PID != uint32(plan.Core.PID) || event.Code != 3 || event.Thread == 0 {
		recoveryPauseContinue.Call(uintptr(event.PID), uintptr(event.Thread), 0x00010002)
		recoveryPauseDetach.Call(uintptr(plan.Core.PID))
		return errors.New("test.pause_unexpected_initial_debug_event")
	}
	// CREATE_PROCESS_DEBUG_EVENT is held uncontinued: documented all-thread
	// suspension, not a guessed delay or an incomplete SuspendThread snapshot.
	if file := windows.Handle(event.Union[0]); file != 0 && file != windows.InvalidHandle {
		windows.CloseHandle(file)
	}
	defer windows.CloseHandle(windows.Handle(event.Union[1]))
	defer windows.CloseHandle(windows.Handle(event.Union[2]))
	actual := &recoveryWindowsProcess{handle: windows.Handle(event.Union[1]), executable: plan.Binary}
	observed, err := actual.inspect(plan.Core.PID)
	if err != nil || observed != plan.Core {
		recoveryPauseContinue.Call(uintptr(event.PID), uintptr(event.Thread), 0x00010002)
		recoveryPauseDetach.Call(uintptr(plan.Core.PID))
		return errors.New("test.pause_debug_event_process_identity_mismatch")
	}
	pausedTick, pausedTickErr := recoveryPauseTickMilliseconds()
	pausedClock := time.Now() // Sample tick first; both clocks must cover the hold.
	proof := recoveryPauseProof{ID: plan.ID, CorePID: plan.Core.PID, CreationSHA: plan.Core, IdentityVerified: true, RequestedHeldMilliseconds: plan.HeldMillis, PausedAt: pausedClock.UTC(), PausedTickMilliseconds: pausedTick, ControllerPID: self.PID}
	writeErr := errors.Join(pausedTickErr, recoveryPauseWrite(plan.Root, "paused.json", proof))
	heldUntil := pausedClock.Add(time.Duration(plan.HeldMillis) * time.Millisecond)
	holdComplete := false
	var releaseFailure error
	for writeErr == nil && !recoveryPauseReleaseRequested(plan) {
		nowTick, tickErr := recoveryPauseTickMilliseconds()
		if tickErr != nil || nowTick < pausedTick {
			writeErr = errors.New("test.pause_monotonic_tick_unavailable")
			break
		}
		guardAlive, guardErr := guard.Alive()
		runnerAlive, runnerErr := runner.Alive()
		complete := !time.Now().Before(heldUntil) && nowTick-pausedTick >= uint64(plan.HeldMillis)
		action := recoveryPauseHoldDecision(runnerAlive, guardAlive, runnerErr, guardErr, complete, !time.Now().Before(hardUntil))
		if action == recoveryPauseRelease {
			holdComplete = true
			break
		}
		if action == recoveryPauseGuardTakeover {
			releaseFailure = recoveryPauseAwaitGuardTakeover(guard, hardUntil)
			break // A return means guard takeover failed; containment is FAIL.
		}
		if action == recoveryPauseReleaseFailed {
			releaseFailure = errors.Join(errors.New("test.pause_cleanup_authority_lost"), guardErr, runnerErr)
			break
		}
		time.Sleep(time.Millisecond)
	}
	// Check again immediately before releasing, including after a parent cancel
	// request. A dead runner transfers release authority to the live guard.
	guardAlive, guardErr := guard.Alive()
	runnerAlive, runnerErr := runner.Alive()
	action := recoveryPauseHoldDecision(runnerAlive, guardAlive, runnerErr, guardErr, holdComplete, !time.Now().Before(hardUntil))
	if action == recoveryPauseGuardTakeover {
		releaseFailure = errors.Join(releaseFailure, recoveryPauseAwaitGuardTakeover(guard, hardUntil))
	} else if action == recoveryPauseReleaseFailed {
		releaseFailure = errors.Join(releaseFailure, errors.New("test.pause_cleanup_authority_lost"), guardErr, runnerErr)
	}
	tick, tickErr := recoveryPauseTickMilliseconds()
	proof.ReleaseStartedTickMilliseconds = tick
	proof.ReleaseStartedAt = time.Now().UTC()
	if writeErr != nil || !holdComplete {
		releaseFailure = errors.Join(releaseFailure, errors.New("test.pause_hold_interrupted"), writeErr)
	}
	if tickErr != nil {
		releaseFailure = errors.Join(releaseFailure, tickErr)
	}
	if releaseFailure != nil {
		// Publish failure before any defensive Continue/Detach. After joining the
		// debugger, the guard must retain this failure even if it won a kill race.
		intent := recoveryPauseFailedRelease{ID: plan.ID, Core: plan.Core, ControllerPID: self.PID, ErrorCode: releaseFailure.Error()}
		if err := recoveryPauseWrite(plan.Root, "controller-failed-release.json", intent); err != nil {
			// Never perform an unrecorded competing release. Returning exits this
			// debugger with KillOnExit(FALSE); normal resumed proof remains absent.
			return errors.Join(releaseFailure, err)
		}
	}
	continued, _, _ := recoveryPauseContinue.Call(uintptr(event.PID), uintptr(event.Thread), 0x00010002) // DBG_CONTINUE
	detached, _, _ := recoveryPauseDetach.Call(uintptr(plan.Core.PID))
	proof.ReleasedAt = time.Now().UTC()
	proof.ReleasedTickMilliseconds, err = recoveryPauseTickMilliseconds()
	tickErr = errors.Join(tickErr, err)
	if continued == 0 || detached == 0 || recoveryPauseAliveDetached(core) != nil {
		releaseFailure = errors.Join(releaseFailure, errors.New("test.pause_cleanup_failed"))
	} else {
		proof.CleanupConfirmed, proof.Outcome = true, "resumed"
	}
	if tickErr != nil {
		releaseFailure = errors.Join(releaseFailure, tickErr)
	}
	if releaseFailure != nil {
		proof.ErrorCode = releaseFailure.Error()
	}
	if err := recoveryPauseWrite(plan.Root, "controller-result.json", proof); err != nil {
		return err
	}
	if proof.ErrorCode != "" {
		return errors.New(proof.ErrorCode)
	}
	return nil
}

// This function never returns a success: the guard must terminate this exact
// debugger process, whose existing KillOnExit(FALSE) policy performs detach.
// If the guard is lost or the original monotonic lifetime ends, return FAIL so
// the controller can perform bounded defensive release, never a profile pass.
func recoveryPauseAwaitGuardTakeover(guard recoveryExactProcess, hardUntil time.Time) error {
	for time.Now().Before(hardUntil) {
		alive, err := guard.Alive()
		if err != nil || !alive {
			return errors.Join(errors.New("test.pause_guard_takeover_lost"), err)
		}
		time.Sleep(time.Millisecond)
	}
	return errors.New("test.pause_guard_takeover_deadline_expired")
}

func recoveryPauseReleaseRequested(plan recoveryPausePlan) bool {
	var command struct {
		ID string `json:"id"`
	}
	err := recoveryPauseRead(plan.Root, "release.json", &command)
	return err == nil && command.ID == plan.ID
}

func recoveryPauseRunGuard(plan recoveryPausePlan) error {
	// Serialized UTC is not authority for a new lifetime. All helpers share
	// this Windows boot's immutable deadline tick, including before startup.
	anchor := time.Now()
	tick, err := recoveryPauseTickMilliseconds()
	if err != nil {
		return err
	}
	remaining, err := plan.remainingAt(tick)
	if err != nil {
		return err
	}
	hardUntil := anchor.Add(remaining)
	hardDeadline := time.NewTimer(time.Until(hardUntil))
	defer hardDeadline.Stop()
	self, err := recoveryPauseSelf(plan.TestBinary)
	if err != nil || self.ParentPID != plan.Runner.PID {
		return errors.New("test.pause_guard_identity_mismatch")
	}
	core, err := recoveryPauseOpenExpected(plan.Core, plan.Binary)
	if err != nil {
		return err
	}
	defer core.Close()
	runner, err := recoveryPauseObserveRunner(plan.Runner, plan.TestBinary)
	if err != nil {
		return err
	}
	defer runner.Close()
	controller, err := recoveryPauseOpenExpected(plan.Controller, plan.TestBinary)
	if err != nil {
		return err
	}
	defer controller.Close()
	if err := recoveryPauseAliveDetached(core); err != nil {
		return err
	}
	ready := recoveryPauseReady{ID: plan.ID, Core: plan.Core, Controller: plan.Controller, Guard: self, Deadline: plan.Deadline, At: time.Now().UTC()}
	if err := recoveryPauseWrite(plan.Root, "guard-ready.json", ready); err != nil {
		return err
	}
	for {
		select {
		case <-hardDeadline.C:
			return recoveryPauseGuardCleanup(plan, core, controller, errors.New("test.pause_guard_deadline_expired"))
		default:
		}
		controllerAlive, controllerErr := controller.Alive()
		runnerAlive, runnerErr := runner.Alive()
		var proof recoveryPauseProof
		readErr := recoveryPauseRead(plan.Root, "controller-result.json", &proof)
		if readErr == nil {
			ledger := recoveryPauseReceiptLedger{}
			resultErr := ledger.accept(plan, proof, time.Now().UTC())
			if proof.ErrorCode != "" {
				resultErr = errors.Join(errors.New(proof.ErrorCode), resultErr)
			}
			if resultErr != nil {
				return recoveryPauseGuardCleanup(plan, core, controller, resultErr)
			}
			if runnerErr != nil || !runnerAlive || !time.Now().Before(hardUntil) {
				return recoveryPauseGuardCleanup(plan, core, controller, errors.Join(errors.New("test.pause_runner_lost_after_controller_release"), runnerErr))
			}
			if err := recoveryPauseAliveDetached(core); err != nil {
				return recoveryPauseGuardCleanup(plan, core, controller, err)
			}
			return recoveryPauseWrite(plan.Root, "guard-result.json", proof)
		}
		if !os.IsNotExist(readErr) {
			return recoveryPauseGuardCleanup(plan, core, controller, readErr)
		}
		if !time.Now().Before(hardUntil) {
			return recoveryPauseGuardCleanup(plan, core, controller, errors.New("test.pause_guard_deadline_expired"))
		}
		if controllerErr != nil || runnerErr != nil || !controllerAlive || !runnerAlive {
			return recoveryPauseGuardCleanup(plan, core, controller, errors.Join(controllerErr, runnerErr))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func recoveryPauseGuardCleanup(plan recoveryPausePlan, core, controller recoveryExactProcess, cleanupErr error) error {
	tick, tickErr := recoveryPauseTickMilliseconds()
	proof := recoveryPauseProof{ID: plan.ID, CorePID: plan.Core.PID, CreationSHA: plan.Core, IdentityVerified: true, RequestedHeldMilliseconds: plan.HeldMillis, ControllerPID: plan.Controller.PID, ReleaseStartedAt: time.Now().UTC(), ReleaseStartedTickMilliseconds: tick}
	if tickErr != nil {
		cleanupErr = errors.Join(cleanupErr, tickErr)
	}
	var paused recoveryPauseProof
	if recoveryPauseRead(plan.Root, "paused.json", &paused) == nil && paused.ID == plan.ID && paused.CreationSHA == plan.Core {
		proof.PausedAt = paused.PausedAt
		proof.PausedTickMilliseconds = paused.PausedTickMilliseconds
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	alive, err := controller.Alive()
	cleanupErr = errors.Join(cleanupErr, err)
	if err == nil && alive {
		// Only the held exact controller can be killed here. Its debug thread
		// exit invokes the already configured Win32 automatic detach policy.
		terminationErr := controller.Terminate(cleanup)
		cleanupErr = errors.Join(cleanupErr, terminationErr)
		proof.GuardTerminatedController = terminationErr == nil
	}
	// Terminate joins the original debugger before this immutable receipt check.
	// A defensive failed release can never be relabeled as successful takeover.
	var failed recoveryPauseFailedRelease
	if err := recoveryPauseRead(plan.Root, "controller-failed-release.json", &failed); err == nil {
		cleanupErr = errors.Join(cleanupErr, failed.cause(plan))
	} else if !os.IsNotExist(err) {
		cleanupErr = errors.Join(cleanupErr, err)
	}
	for {
		if recoveryPauseAliveDetached(core) == nil {
			proof.ReleasedAt = time.Now().UTC()
			proof.ReleasedTickMilliseconds, tickErr = recoveryPauseTickMilliseconds()
			if tickErr != nil {
				cleanupErr = errors.Join(cleanupErr, tickErr)
			}
			proof.CleanupConfirmed, proof.Outcome = true, "detached"
			if cleanupErr != nil {
				proof.ErrorCode = cleanupErr.Error()
			}
			return errors.Join(cleanupErr, recoveryPauseWrite(plan.Root, "guard-result.json", proof))
		}
		if cleanup.Err() != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// This is failure containment, not successful recovery. An unknown debug
	// state never earns PASS, even if exact test-core termination succeeds.
	stop, cancelStop := context.WithTimeout(context.Background(), time.Second)
	defer cancelStop()
	if alive, err := core.Alive(); err == nil && alive {
		_ = core.Terminate(stop)
	}
	cleanupErr = errors.Join(cleanupErr, errors.New("test.pause_cleanup_failed"))
	proof.ReleasedAt, proof.Outcome, proof.ErrorCode = time.Now().UTC(), "terminated", cleanupErr.Error()
	proof.ReleasedTickMilliseconds, _ = recoveryPauseTickMilliseconds()
	_ = recoveryPauseWrite(plan.Root, "guard-result.json", proof)
	return cleanupErr
}
