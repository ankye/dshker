//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/core"
)

func TestWorkbenchRecoveryPauseGuardOwnsReleaseAfterRunnerDeath(t *testing.T) {
	queryFailed := errors.New("original runner observation failed")
	for _, item := range []struct {
		name                    string
		runnerAlive, guardAlive bool
		runnerErr, guardErr     error
		complete, expired       bool
		want                    recoveryPauseHoldAction
	}{
		{"holding", true, true, nil, nil, false, false, recoveryPauseHolding},
		{"normal full hold", true, true, nil, nil, true, false, recoveryPauseRelease},
		{"runner died", false, true, nil, nil, false, false, recoveryPauseGuardTakeover},
		{"runner died at full hold", false, true, nil, nil, true, false, recoveryPauseGuardTakeover},
		{"runner observation failed", false, true, queryFailed, nil, false, false, recoveryPauseGuardTakeover},
		{"guard died", true, false, nil, nil, false, false, recoveryPauseReleaseFailed},
		{"both died", false, false, nil, nil, false, false, recoveryPauseReleaseFailed},
		{"guard query failed", false, true, nil, queryFailed, false, false, recoveryPauseReleaseFailed},
		{"original deadline", false, true, nil, nil, false, true, recoveryPauseReleaseFailed},
		{"full hold after deadline", true, true, nil, nil, true, true, recoveryPauseReleaseFailed},
	} {
		t.Run(item.name, func(t *testing.T) {
			if got := recoveryPauseHoldDecision(item.runnerAlive, item.guardAlive, item.runnerErr, item.guardErr, item.complete, item.expired); got != item.want {
				t.Fatalf("release owner got=%d want=%d", got, item.want)
			}
		})
	}
}

func TestWorkbenchRecoveryPauseGuardOwnsAndRetainsFailedReleaseCause(t *testing.T) {
	plan, _, _ := recoveryPausePurePlan()
	plan.Root = t.TempDir()
	original := "test.pause_guard_takeover_lost\ntest.pause_hold_interrupted"
	failed := recoveryPauseFailedRelease{ID: plan.ID, Core: plan.Core, ControllerPID: plan.Controller.PID, ErrorCode: original}
	must(t, recoveryPauseWrite(plan.Root, "controller-failed-release.json", failed))
	var recorded recoveryPauseFailedRelease
	must(t, recoveryPauseRead(plan.Root, "controller-failed-release.json", &recorded))
	if err := recorded.cause(plan); err == nil || err.Error() != original {
		t.Fatal("guard cleared or replaced the original defensive release error", err)
	}
	for _, alter := range []func(*recoveryPauseFailedRelease){
		func(f *recoveryPauseFailedRelease) { f.ID = "foreign" },
		func(f *recoveryPauseFailedRelease) { f.Core.Creation++ },
		func(f *recoveryPauseFailedRelease) { f.ControllerPID++ },
		func(f *recoveryPauseFailedRelease) { f.ErrorCode = "" },
	} {
		invalid := recorded
		alter(&invalid)
		if err := invalid.cause(plan); err == nil || err.Error() != "test.pause_failed_release_receipt_mismatch" {
			t.Fatal("foreign or empty defensive release cause was accepted", invalid, err)
		}
	}
}

func TestWorkbenchRecoveryPauseDebuggerResultsPreserveNativeFailure(t *testing.T) {
	for _, present := range []uint32{0, 1} {
		observation, err := recoveryPauseDebuggerResult(0, present, 5)
		var native *recoveryPauseDebugAPIError
		if observation.Succeeded || observation.DebuggerPresent || observation.Win32Error != 5 || !errors.As(err, &native) || native.Win32Error != 5 || !errors.Is(err, syscall.Errno(5)) || !strings.Contains(err.Error(), "win32=5") {
			t.Fatal("query failure lost its exact native error or became debugger-present", observation, err)
		}
	}
	for _, present := range []uint32{0, 1} {
		observation, err := recoveryPauseDebuggerResult(1, present, 5)
		if err != nil || !observation.Succeeded || observation.DebuggerPresent != (present != 0) || observation.Win32Error != 0 {
			t.Fatal("successful query consumed stale GetLastError or lost debugger state", observation, err)
		}
	}
	observation, err := recoveryPauseDebuggerResult(0, 0, 0)
	if err == nil || observation.Succeeded || !strings.Contains(err.Error(), "win32=0") {
		t.Fatal("failure with zero native error became a successful query", observation, err)
	}
}

func TestWorkbenchRecoveryPauseRequiresOriginalIdentityForQueryHandle(t *testing.T) {
	plan, _, _ := recoveryPausePurePlan()
	must(t, recoveryPauseRequireSameIdentity(plan.Core, plan.Core))
	for _, alter := range []func(*recoveryProcessProof){
		func(p *recoveryProcessProof) { p.PID++ },
		func(p *recoveryProcessProof) { p.ParentPID++ },
		func(p *recoveryProcessProof) { p.Creation++ },
		func(p *recoveryProcessProof) { p.ExecutableSHA256 = strings.Repeat("c", 64) },
		func(p *recoveryProcessProof) { p.Creation = 0 },
		func(p *recoveryProcessProof) { p.ExecutableSHA256 = "" },
	} {
		observed := plan.Core
		alter(&observed)
		if recoveryPauseRequireSameIdentity(plan.Core, observed) == nil {
			t.Fatal("required query handle replaced the original held process identity", observed)
		}
	}
	if recoveryPauseRequireSameIdentity(recoveryProcessProof{}, recoveryProcessProof{}) == nil {
		t.Fatal("two missing identities were accepted as an exact process")
	}
}

func TestWorkbenchRecoveryPauseRequiresExplicitOwnerRootsAndHome(t *testing.T) {
	binary, err := os.Executable()
	must(t, err)
	config := recoveryPauseCoreInputs(t, binary)
	command, err := recoveryPauseCoreCommand(config)
	must(t, err)
	owner, err := recoveryOwnerConfiguration(command)
	must(t, err)
	if owner.Executable != config.Binary || owner.StateRoot != config.State || owner.DataRoot != config.Data || owner.CatalogRoot != config.Catalog || owner.RootsPath != config.Roots {
		t.Fatal("pause preflight did not preserve all five explicit owner inputs")
	}
	var homes []string
	for _, entry := range command.Env {
		name, value, found := strings.Cut(entry, "=")
		if found && strings.EqualFold(name, "DSH_HOME") {
			homes = append(homes, value)
		}
	}
	if len(homes) != 1 || homes[0] != config.Home {
		t.Fatal("pause preflight inherited or duplicated a different DSH home", homes)
	}
	for _, remove := range []func(*recoveryPauseOrphanConfig){
		func(c *recoveryPauseOrphanConfig) { c.Binary = "" },
		func(c *recoveryPauseOrphanConfig) { c.State = "" },
		func(c *recoveryPauseOrphanConfig) { c.Data = "" },
		func(c *recoveryPauseOrphanConfig) { c.Catalog = "" },
		func(c *recoveryPauseOrphanConfig) { c.Roots = "" },
		func(c *recoveryPauseOrphanConfig) { c.Home = "" },
		func(c *recoveryPauseOrphanConfig) { c.Home = c.Roots },
	} {
		invalid := config
		remove(&invalid)
		if _, err := recoveryPauseCoreCommand(invalid); err == nil {
			t.Fatal("missing or non-directory owner input was silently substituted")
		}
	}
}

func recoveryPausePurePlan() (recoveryPausePlan, recoveryPauseProof, time.Time) {
	created := time.Now().UTC().Add(-4 * time.Second).Truncate(time.Millisecond)
	identity := func(pid, parent int) recoveryProcessProof {
		return recoveryProcessProof{PID: pid, ParentPID: parent, Creation: uint64(pid) + 100, ExecutableSHA256: strings.Repeat("a", 64)}
	}
	plan := recoveryPausePlan{ID: strings.Repeat("b", 32), Root: filepath.Join(os.TempDir(), "dshker-program-pause-pure"), Binary: filepath.Join(os.TempDir(), "dshker-recovery-cross-pure", "dshkerd.exe"), TestBinary: filepath.Join(os.TempDir(), "integration.test.exe"), Core: identity(200, 100), Runner: identity(100, 50), Controller: identity(300, 100), CreatedAt: created, Deadline: created.Add(18 * time.Second), CreatedTickMilliseconds: 120455, DeadlineTickMilliseconds: 138455, HeldMillis: 3000}
	proof := recoveryPauseProof{ID: plan.ID, CorePID: plan.Core.PID, CreationSHA: plan.Core, IdentityVerified: true, RequestedHeldMilliseconds: 3000, PausedAt: created.Add(time.Millisecond), PausedTickMilliseconds: 120456, ReleaseStartedAt: created.Add(3001 * time.Millisecond), ReleaseStartedTickMilliseconds: 123456, ReleasedAt: created.Add(3010 * time.Millisecond), ReleasedTickMilliseconds: 123465, ControllerPID: plan.Controller.PID, CleanupConfirmed: true, Outcome: "resumed"}
	return plan, proof, created.Add(4 * time.Second)
}

func TestWorkbenchRecoveryPauseHelpersShareOriginalMonotonicDeadline(t *testing.T) {
	plan, _, _ := recoveryPausePurePlan()
	// Clock rollback before either helper starts cannot extend the original
	// boot-tick deadline. UTC may look future but supplies no new budget.
	plan.Deadline = time.Now().UTC().Add(24 * time.Hour)
	remaining, err := plan.remainingAt(plan.DeadlineTickMilliseconds - 1)
	if err != nil || remaining != time.Millisecond {
		t.Fatal("shared tick deadline changed", remaining, err)
	}
	for _, tick := range []uint64{0, plan.CreatedTickMilliseconds - 1, plan.DeadlineTickMilliseconds, plan.DeadlineTickMilliseconds + 1, ^uint64(0)} {
		if _, err := plan.remainingAt(tick); err == nil {
			t.Fatal("backward/expired tick granted a helper a new lifetime", tick)
		}
	}
	plan.DeadlineTickMilliseconds = plan.CreatedTickMilliseconds + uint64(plan.HeldMillis) + 15001
	if _, err := plan.remainingAt(plan.CreatedTickMilliseconds); err == nil {
		t.Fatal("extended immutable deadline accepted")
	}
}

func TestWorkbenchRecoveryPauseVersionMatchesActualCoreWire(t *testing.T) {
	result, err := core.Handle(context.Background(), "core.version", json.RawMessage(`{}`))
	must(t, err)
	data, err := json.Marshal(result)
	must(t, err)
	must(t, recoveryPauseVersion(data))
	for _, raw := range []string{`{"version":"1","methodTableVersion":2,"methods":["core.version"]}`, `{"version":1,"methodTableVersion":1,"methods":["core.version"]}`, `{"version":1,"methodTableVersion":2,"methods":[]}`, `{"version":1,"methodTableVersion":2,"methods":["unrelated"]}`} {
		if recoveryPauseVersion([]byte(raw)) == nil {
			t.Fatal("unsupported native core wire admitted", raw)
		}
	}
}

func TestWorkbenchRecoveryPauseRejectsExpiredOverlappingAndUnapprovedOperation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	controller := &recoveryPauseController{}
	if _, err := controller.Pause(ctx, 3*time.Second); err == nil {
		t.Fatal("expired context admitted before native prerequisites")
	}
	for _, duration := range []time.Duration{0, time.Second, 34 * time.Second, 36 * time.Second} {
		if _, err := controller.Pause(context.Background(), duration); err == nil {
			t.Fatal("unapproved pause duration admitted")
		}
	}
	controller.active = &recoveryPauseRun{}
	if _, err := controller.Pause(context.Background(), 3*time.Second); err == nil {
		t.Fatal("overlapping pause admitted")
	}
	controller.active = nil
	must(t, controller.Close(context.Background()))
	if _, err := controller.Pause(context.Background(), 3*time.Second); err == nil {
		t.Fatal("closed controller admitted a new operation")
	}
	must(t, controller.Close(context.Background()))
}

func TestWorkbenchRecoveryPauseObserverUsesItsOwnMonotonicDeadline(t *testing.T) {
	plan, proof, _ := recoveryPausePurePlan()
	plan.Root = t.TempDir()
	// A serialized wall deadline can still appear future after clock rollback;
	// the admitted local monotonic lifetime is nevertheless already exhausted.
	plan.Deadline = time.Now().UTC().Add(time.Hour)
	must(t, recoveryPauseWrite(plan.Root, "paused.json", proof))
	run := &recoveryPauseRun{plan: plan, hardUntil: time.Now().Add(-time.Millisecond), cancel: make(chan struct{})}
	var buffered recoveryPauseProof
	if err := run.waitFile(context.Background(), "paused.json", &buffered); err == nil || !buffered.PausedAt.IsZero() {
		t.Fatal("buffered receipt crossed the independent monotonic admission lifetime")
	}
}

func TestWorkbenchRecoveryPauseRejectsMissingForeignLateAndDuplicateReceipt(t *testing.T) {
	plan, proof, now := recoveryPausePurePlan()
	must(t, plan.validate(now))
	var ledger recoveryPauseReceiptLedger
	must(t, ledger.accept(plan, proof, now))
	if ledger.accept(plan, proof, now) == nil {
		t.Fatal("duplicate final receipt was accepted as a new pause")
	}
	for _, alter := range []func(*recoveryPauseProof){
		func(p *recoveryPauseProof) { p.ID = strings.Repeat("c", 32) },
		func(p *recoveryPauseProof) { p.CorePID++ },
		func(p *recoveryPauseProof) { p.CreationSHA.Creation++ },
		func(p *recoveryPauseProof) { p.CreationSHA.ParentPID++ },
		func(p *recoveryPauseProof) { p.CreationSHA.ExecutableSHA256 = strings.Repeat("d", 64) },
		func(p *recoveryPauseProof) { p.ControllerPID++ },
		func(p *recoveryPauseProof) { p.IdentityVerified = false },
		func(p *recoveryPauseProof) { p.RequestedHeldMilliseconds = 35000 },
		func(p *recoveryPauseProof) { p.PausedAt = time.Time{} },
		func(p *recoveryPauseProof) { p.ReleaseStartedAt = p.ReleaseStartedAt.Add(-time.Millisecond) },
		func(p *recoveryPauseProof) { p.ReleaseStartedTickMilliseconds = 0 },
		func(p *recoveryPauseProof) { p.PausedTickMilliseconds = p.ReleaseStartedTickMilliseconds - 2999 },
		func(p *recoveryPauseProof) { p.ReleasedTickMilliseconds = p.ReleaseStartedTickMilliseconds - 1 },
		func(p *recoveryPauseProof) { p.ReleasedAt = plan.Deadline.Add(time.Second) },
		func(p *recoveryPauseProof) { p.CleanupConfirmed = false },
		func(p *recoveryPauseProof) { p.Outcome = "detached" },
		func(p *recoveryPauseProof) { p.Outcome = "terminated" },
		func(p *recoveryPauseProof) { p.ErrorCode = "test.pause_cleanup_failed" },
		func(p *recoveryPauseProof) { p.GuardTerminatedController = true },
	} {
		changed := proof
		alter(&changed)
		if (&recoveryPauseReceiptLedger{}).accept(plan, changed, now) == nil {
			t.Fatalf("foreign, partial or invalid pause proof admitted: %+v", changed)
		}
	}
	if (&recoveryPauseReceiptLedger{}).accept(plan, proof, plan.Deadline) == nil {
		t.Fatal("buffered success crossed the hard deadline")
	}
	data, err := json.Marshal(proof)
	must(t, err)
	var fields map[string]json.RawMessage
	must(t, json.Unmarshal(data, &fields))
	for name := range fields {
		var missing map[string]json.RawMessage
		must(t, json.Unmarshal(data, &missing))
		delete(missing, name)
		encoded, err := json.Marshal(missing)
		must(t, err)
		var target recoveryPauseProof
		if recoveryPauseDecode(encoded, &target) == nil {
			t.Fatalf("missing receipt field admitted: %s", name)
		}
	}
	for _, invalid := range [][]byte{[]byte(`{}`), append(append([]byte{}, data...), []byte(` {}`)...), []byte(strings.Replace(string(data), `"corePid":200`, `"corePid":200,"corePid":200`, 1))} {
		var target recoveryPauseProof
		if recoveryPauseDecode(invalid, &target) == nil {
			t.Fatal("empty, trailing or duplicate-key receipt admitted")
		}
	}
}

func TestWorkbenchRecoveryPauseRequiresExactScopeAndFreshGuardReady(t *testing.T) {
	plan, _, now := recoveryPausePurePlan()
	ready := recoveryPauseReady{ID: plan.ID, Core: plan.Core, Controller: plan.Controller, Guard: recoveryProcessProof{PID: 400, ParentPID: plan.Runner.PID, Creation: 500, ExecutableSHA256: strings.Repeat("a", 64)}, Deadline: plan.Deadline, At: now}
	must(t, plan.acceptReady(ready, now))
	for _, alter := range []func(*recoveryPauseReady){
		func(r *recoveryPauseReady) { r.ID = "" },
		func(r *recoveryPauseReady) { r.Core.PID++ },
		func(r *recoveryPauseReady) { r.Controller.Creation++ },
		func(r *recoveryPauseReady) { r.Guard.ParentPID++ },
		func(r *recoveryPauseReady) { r.Guard.PID = plan.Core.PID },
		func(r *recoveryPauseReady) { r.At = plan.CreatedAt.Add(-time.Millisecond) },
		func(r *recoveryPauseReady) { r.At = now.Add(time.Millisecond) },
		func(r *recoveryPauseReady) { r.Deadline = plan.Deadline.Add(time.Second) },
	} {
		changed := ready
		alter(&changed)
		if plan.acceptReady(changed, now) == nil {
			t.Fatal("foreign or late guard readiness admitted")
		}
	}
	for _, binary := range []string{filepath.Join(os.TempDir(), "dshkerd.exe"), strings.Replace(plan.Binary, "dshkerd.exe", "node.exe", 1), plan.Binary + "\n", filepath.Join(os.TempDir(), "Programs", "dshker-recovery-cross-fake", "dshkerd.exe")} {
		if recoveryPauseScope(binary, os.TempDir(), plan.Core.PID, plan.Core.ParentPID) == nil {
			t.Fatalf("unowned executable was admitted: %q", binary)
		}
	}
	for _, alter := range []func(*recoveryPausePlan){
		func(p *recoveryPausePlan) { p.HeldMillis = 1000 },
		func(p *recoveryPausePlan) { p.Core.Creation = 0 },
		func(p *recoveryPausePlan) { p.Controller.ParentPID++ },
		func(p *recoveryPausePlan) { p.Deadline = now },
		func(p *recoveryPausePlan) { p.Deadline = p.Deadline.Add(time.Second) },
		func(p *recoveryPausePlan) { p.Root = os.TempDir() },
	} {
		changed := plan
		alter(&changed)
		if changed.validate(now) == nil {
			t.Fatal("unsafe pause plan admitted")
		}
	}
}
