//go:build live

package integration

import (
	"context"
	"encoding/hex"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

type recoveryOwnerShutdownClient interface {
	Shutdown(context.Context) error
	Close() error
}

// This lifetime owns only authenticated teardown of one already-running owner.
// It cannot create a replacement authority or terminate a process directly.
type recoveryOwnerTeardown struct {
	identity runtimeowner.Identity
	attach   func(context.Context) (recoveryOwnerShutdownClient, error)
	held     recoveryExactProcess
	once     sync.Once
	result   error
}

func recoveryRegisterOwnerTeardown(t *testing.T, command *exec.Cmd) *recoveryOwnerTeardown {
	t.Helper()
	config, err := recoveryOwnerConfiguration(command)
	must(t, err)
	environment := append([]string(nil), command.Env...)
	identity, err := runtimeowner.InspectIdentityForEnvironment(config, environment)
	must(t, err)
	held, err := recoveryHoldExactProcess(identity.PID, command.Process.Pid, command.Path)
	must(t, err)
	if err := recoveryAdmitOwnerIdentity(identity, identity.Config, held.Proof(), command.Process.Pid); err != nil {
		must(t, held.Close())
		t.Fatal(err)
	}
	owner := &recoveryOwnerTeardown{
		identity: identity, held: held,
		attach: func(ctx context.Context) (recoveryOwnerShutdownClient, error) {
			return runtimeowner.AttachExisting(ctx, config, environment, identity)
		},
	}
	// Registered before any later attach/configure/start/open failure. The parent
	// also invokes it before Close; once keeps post-crash teardown idempotent.
	t.Cleanup(func() { owner.finish(t) })
	return owner
}

func (owner *recoveryOwnerTeardown) finish(t *testing.T) {
	t.Helper()
	if err := owner.closeBounded(); err != nil {
		t.Errorf("test runtime-owner exact teardown failed ownerPid=%d: %v", owner.identity.PID, err)
	}
}

func (owner *recoveryOwnerTeardown) closeBounded() error {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	return owner.close(ctx)
}

func (owner *recoveryOwnerTeardown) stopThenClose(stopContext context.Context, stop func(context.Context) error) (error, error) {
	stopErr := stop(stopContext)
	// A stop timeout is retained, but cannot consume the sole authenticated
	// owner's independent teardown attempt through an already-cancelled context.
	return stopErr, owner.closeBounded()
}

func (owner *recoveryOwnerTeardown) close(ctx context.Context) error {
	owner.once.Do(func() {
		defer func() { owner.result = errors.Join(owner.result, owner.held.Close()) }()
		client, err := owner.attach(ctx)
		if err != nil {
			owner.result = err // Missing/refused identity is failure, never success.
			return
		}
		shutdownErr := client.Shutdown(ctx)
		closeErr := client.Close()
		alive, aliveErr := owner.held.Alive()
		owner.result = errors.Join(shutdownErr, closeErr, aliveErr)
		if alive {
			owner.result = errors.Join(owner.result, errors.New("test.owner_held_process_not_exited"))
		}
	})
	return owner.result
}

// Reconstruct only the exact explicit command roots, never a home-derived root
// or an alternative registration. The owner independently validates the result.
func recoveryOwnerConfiguration(command *exec.Cmd) (runtimeowner.Config, error) {
	if command == nil || !filepath.IsAbs(command.Path) || len(command.Args) < 2 || command.Args[1] != "serve" {
		return runtimeowner.Config{}, errors.New("test.owner_command_identity_invalid")
	}
	config := runtimeowner.Config{Executable: command.Path}
	targets := map[string]*string{"--state": &config.StateRoot, "--data": &config.DataRoot, "--catalog": &config.CatalogRoot, "--roots": &config.RootsPath}
	seen := map[string]bool{}
	for index := 2; index < len(command.Args); index += 2 {
		name := command.Args[index]
		target, known := targets[name]
		if !known || seen[name] || index+1 >= len(command.Args) || !filepath.IsAbs(command.Args[index+1]) {
			return runtimeowner.Config{}, errors.New("test.owner_command_roots_invalid")
		}
		seen[name] = true
		*target = command.Args[index+1]
	}
	if len(seen) != len(targets) {
		return runtimeowner.Config{}, errors.New("test.owner_command_roots_missing")
	}
	return config, nil
}

type recoveryConsoleSnapshot struct {
	Entries []harnessruntime.ConsoleEntry `json:"entries"`
	Cursor  int64                         `json:"cursor"`
}

func recoveryReadConsole(ctx context.Context, core *localrpc.Peer) (recoveryConsoleSnapshot, error) {
	raw, err := core.Call(ctx, "runtime.console", map[string]int64{"cursor": 0})
	if err != nil {
		return recoveryConsoleSnapshot{}, err
	}
	var result recoveryConsoleSnapshot
	if err := protocol.DecodeExact(raw, &result); err != nil {
		return result, err
	}
	return result, nil
}

func recoverySameConsole(before, after recoveryConsoleSnapshot) bool {
	if before.Cursor <= 0 || after.Cursor < before.Cursor || len(after.Entries) == 0 || after.Entries[len(after.Entries)-1].Sequence != after.Cursor {
		return false
	}
	current := make(map[int64]harnessruntime.ConsoleEntry, len(after.Entries))
	var previous int64
	for _, entry := range after.Entries {
		if entry.Sequence <= previous || entry.Sequence > after.Cursor {
			return false
		}
		previous = entry.Sequence
		current[entry.Sequence] = entry
	}
	for _, original := range before.Entries {
		if original.Sequence < after.Entries[0].Sequence {
			continue
		} // Production's bounded feed may legitimately prune old entries.
		if value, exists := current[original.Sequence]; !exists || value != original {
			return false
		}
	}
	return true
}

func recoveryAdmitOwnerIdentity(identity runtimeowner.Identity, expected runtimeowner.Config, proof recoveryProcessProof, corePID int) error {
	instance, err := hex.DecodeString(identity.Instance)
	creation, creationErr := strconv.ParseUint(identity.Creation, 10, 64)
	if err != nil || len(instance) != 16 || identity.Version != runtimeowner.ProtocolVersion || creationErr != nil || creation == 0 || creation != proof.Creation || identity.PID <= 0 || identity.PID != proof.PID || proof.ParentPID != corePID || identity.PID == corePID || identity.ExecutableSHA256 != proof.ExecutableSHA256 || identity.Config != expected {
		return errors.New("test.owner_exact_identity_mismatch")
	}
	return nil
}

func recoveryStopOwnedRuntime(ctx context.Context, core *localrpc.Peer, expected harnessruntime.LaunchView, held recoveryExactProcess) error {
	view, present, err := recoveryReadWindowsStatus(ctx, core, expected.SubjectID)
	if err != nil {
		return err
	}
	if !present || view.PID != expected.PID || view.LaunchID != expected.LaunchID || view.SubjectID != expected.SubjectID || view.StartedAtUnix != expected.StartedAtUnix || view.Directory != expected.Directory {
		return errors.New("test.runtime_cleanup_identity_mismatch")
	}
	if view.State != harnessruntime.StateStopped {
		raw, err := core.Call(ctx, "runtime.stop", map[string]string{"subjectId": expected.SubjectID})
		if err != nil {
			return err
		}
		var response struct {
			Launch harnessruntime.LaunchView `json:"launch"`
		}
		if protocol.DecodeExact(raw, &response) != nil || response.Launch.PID != expected.PID || response.Launch.LaunchID != expected.LaunchID {
			return errors.New("test.runtime_stop_response_identity_mismatch")
		}
	}
	view, present, err = recoveryReadWindowsStatus(ctx, core, expected.SubjectID)
	if err != nil {
		return err
	}
	if !present || view.PID != expected.PID || view.LaunchID != expected.LaunchID || view.State != harnessruntime.StateStopped || view.Diagnostics.ExitCode == nil {
		return errors.New("test.runtime_stop_not_joined")
	}
	alive, err := held.Alive()
	if err != nil || alive {
		return errors.New("test.runtime_stop_held_process_still_alive")
	}
	return nil
}

func TestWorkbenchRecoveryOwnerIdentityRequiresExactProcess(t *testing.T) {
	config := runtimeowner.Config{Executable: "explicit-candidate", StateRoot: "explicit-state"}
	identity := runtimeowner.Identity{Version: runtimeowner.ProtocolVersion, Instance: strings.Repeat("a", 32), PID: 102, Creation: "12345", ExecutableSHA256: strings.Repeat("b", 64), Config: config}
	proof := recoveryProcessProof{PID: 102, ParentPID: 101, Creation: 12345, ExecutableSHA256: identity.ExecutableSHA256}
	if err := recoveryAdmitOwnerIdentity(identity, config, proof, 101); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*runtimeowner.Identity){
		func(value *runtimeowner.Identity) { value.PID++ },
		func(value *runtimeowner.Identity) { value.Creation = "12346" },
		func(value *runtimeowner.Identity) { value.ExecutableSHA256 = strings.Repeat("c", 64) },
		func(value *runtimeowner.Identity) { value.Config.StateRoot = "another-root" },
		func(value *runtimeowner.Identity) { value.Instance = "missing-epoch" },
		func(value *runtimeowner.Identity) { value.Version++ },
	} {
		wrong := identity
		mutate(&wrong)
		if err := recoveryAdmitOwnerIdentity(wrong, config, proof, 101); err == nil {
			t.Fatal("mismatched PID/birth/executable/root/epoch/protocol owner identity was admitted")
		}
	}
	if err := recoveryAdmitOwnerIdentity(identity, config, proof, 999); err == nil {
		t.Fatal("an arbitrary process parent was admitted as the test-owned runtime authority")
	}
}

func TestWorkbenchRecoveryOwnerConsoleRetainsSequenceAndContents(t *testing.T) {
	entry := harnessruntime.ConsoleEntry{Sequence: 17, Stream: "stdout", Text: "sentinel-output", OccurredAtUnix: 123}
	before := recoveryConsoleSnapshot{Entries: []harnessruntime.ConsoleEntry{entry}, Cursor: 17}
	if !recoverySameConsole(before, before) {
		t.Fatal("unchanged original owner console was refused")
	}
	changed := entry
	changed.Text = "different-output"
	for _, after := range []recoveryConsoleSnapshot{
		{Entries: []harnessruntime.ConsoleEntry{}, Cursor: 17},
		{Entries: []harnessruntime.ConsoleEntry{entry}, Cursor: 16},
		{Entries: []harnessruntime.ConsoleEntry{changed}, Cursor: 17},
	} {
		if recoverySameConsole(before, after) {
			t.Fatal("console reset, missing output or rewritten sequence was accepted")
		}
	}
}

func TestWorkbenchRecoveryOwnerConfigurationRequiresExactExplicitRoots(t *testing.T) {
	base := t.TempDir()
	command := exec.Command(filepath.Join(base, "candidate"), "serve", "--state", filepath.Join(base, "state"), "--data", filepath.Join(base, "data"), "--catalog", filepath.Join(base, "catalog"), "--roots", filepath.Join(base, "roots.pem"))
	actual, err := recoveryOwnerConfiguration(command)
	if err != nil || actual.Executable != command.Path || actual.StateRoot != filepath.Join(base, "state") || actual.DataRoot != filepath.Join(base, "data") || actual.CatalogRoot != filepath.Join(base, "catalog") || actual.RootsPath != filepath.Join(base, "roots.pem") {
		t.Fatal("owner inspection did not retain the exact launched candidate configuration")
	}
	for _, arguments := range [][]string{
		{"serve", "--state", filepath.Join(base, "state")},
		append(append([]string{}, command.Args[1:]...), "--state", filepath.Join(base, "other")),
		append(append([]string{}, command.Args[1:]...), "--unknown", filepath.Join(base, "other")),
		{"serve", "--state", "relative", "--data", filepath.Join(base, "data"), "--catalog", filepath.Join(base, "catalog"), "--roots", filepath.Join(base, "roots.pem")},
	} {
		if _, err := recoveryOwnerConfiguration(exec.Command(command.Path, arguments...)); err == nil {
			t.Fatal("incomplete, duplicate or foreign owner roots were admitted")
		}
	}
}

type recoveryOwnerTeardownProbe struct {
	events      *[]string
	alive       bool
	keepAlive   bool
	shutdownErr error
	closeErr    error
	waitErr     error
	shutdownCtx context.Context
}

func (probe *recoveryOwnerTeardownProbe) Shutdown(ctx context.Context) error {
	*probe.events = append(*probe.events, "owner.shutdown")
	probe.shutdownCtx = ctx
	if probe.shutdownErr == nil && !probe.keepAlive {
		probe.alive = false
	}
	return probe.shutdownErr
}
func (probe *recoveryOwnerTeardownProbe) Close() error {
	*probe.events = append(*probe.events, "owner.rpc.close")
	return probe.closeErr
}

type recoveryOwnerHeldProbe struct{ owner *recoveryOwnerTeardownProbe }

func (probe recoveryOwnerHeldProbe) Proof() recoveryProcessProof { return recoveryProcessProof{} }
func (probe recoveryOwnerHeldProbe) Alive() (bool, error) {
	*probe.owner.events = append(*probe.owner.events, "owner.handle.wait")
	return probe.owner.alive, probe.owner.waitErr
}
func (probe recoveryOwnerHeldProbe) Close() error {
	*probe.owner.events = append(*probe.owner.events, "owner.handle.close")
	return nil
}
func (probe recoveryOwnerHeldProbe) Terminate(context.Context) error {
	*probe.owner.events = append(*probe.owner.events, "forbidden-terminate")
	return errors.New("test.owner_teardown_cannot_terminate")
}

func recoveryOwnerTeardownSubject(events *[]string) (*recoveryOwnerTeardown, *recoveryOwnerTeardownProbe) {
	probe := &recoveryOwnerTeardownProbe{events: events, alive: true}
	owner := &recoveryOwnerTeardown{
		held: recoveryOwnerHeldProbe{probe},
		attach: func(context.Context) (recoveryOwnerShutdownClient, error) {
			*events = append(*events, "owner.attach-existing")
			return probe, nil
		},
	}
	return owner, probe
}

func TestWorkbenchRecoveryOwnerTeardownCoversEarlyErrorLIFO(t *testing.T) {
	for _, stage := range []string{"configure-error", "runtime-start-error", "initial-workbench-error"} {
		var events []string
		owner, _ := recoveryOwnerTeardownSubject(&events)
		t.Run(stage, func(t *testing.T) {
			// Mirror actual registrations: exact core cleanup, owner guard, then
			// parent detach, then runtime.stop. t.Cleanup also runs on Fatal/Goexit.
			t.Cleanup(func() { events = append(events, "core.exact-cleanup") })
			t.Cleanup(func() { owner.finish(t) })
			t.Cleanup(func() {
				owner.finish(t)
				events = append(events, "parent.close")
			})
			if stage != "configure-error" {
				t.Cleanup(func() { events = append(events, "runtime.stop") })
			}
			// An early operation error exits without entering the crash case.
			if err := errors.New(stage); err != nil {
				return
			}
			t.Fatal("early operation error was ignored")
		})
		want := []string{"owner.attach-existing", "owner.shutdown", "owner.rpc.close", "owner.handle.wait", "owner.handle.close", "parent.close", "core.exact-cleanup"}
		if stage != "configure-error" {
			want = append([]string{"runtime.stop"}, want...)
		}
		if strings.Join(events, ",") != strings.Join(want, ",") {
			t.Fatalf("%s cleanup order = %v; want %v", stage, events, want)
		}
	}
}

func TestWorkbenchRecoveryOwnerTeardownPostCrashIsOnce(t *testing.T) {
	var events []string
	owner, _ := recoveryOwnerTeardownSubject(&events)
	events = append(events, "runtime.stop")
	var workers sync.WaitGroup
	for index := 0; index < 20; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := owner.close(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	workers.Wait()
	owner.finish(t) // Later initial-parent and guard callbacks cannot reattach.
	want := "runtime.stop,owner.attach-existing,owner.shutdown,owner.rpc.close,owner.handle.wait,owner.handle.close"
	if strings.Join(events, ",") != want {
		t.Fatalf("post-crash teardown repeated or reordered existing-owner operations: %v", events)
	}
}

func TestWorkbenchRecoveryOwnerTeardownOutlivesExhaustedRuntimeStop(t *testing.T) {
	var events []string
	owner, probe := recoveryOwnerTeardownSubject(&events)
	var attached context.Context
	owner.attach = func(ctx context.Context) (recoveryOwnerShutdownClient, error) {
		attached = ctx
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		deadline, present := ctx.Deadline()
		if !present || !deadline.After(time.Now()) || time.Until(deadline) > 35*time.Second {
			return nil, errors.New("test.owner_cleanup_budget_not_independent_and_bounded")
		}
		events = append(events, "owner.attach-existing")
		return probe, nil
	}
	stopContext, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	original := errors.Join(context.DeadlineExceeded, errors.New("test.original_runtime_stop_timeout"))
	stopErr, shutdownErr := owner.stopThenClose(stopContext, func(ctx context.Context) error {
		if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			t.Fatal("runtime stop did not exhaust its own budget")
		}
		events = append(events, "runtime.stop.deadline")
		return original
	})
	if stopErr != original || !errors.Is(stopErr, context.DeadlineExceeded) || shutdownErr != nil || probe.alive || probe.shutdownCtx != attached || attached == stopContext {
		t.Fatalf("exhausted runtime stop lost its failure or cancelled owner join: stop=%v owner=%v", stopErr, shutdownErr)
	}
	owner.finish(t)
	want := "runtime.stop.deadline,owner.attach-existing,owner.shutdown,owner.rpc.close,owner.handle.wait,owner.handle.close"
	if strings.Join(events, ",") != want {
		t.Fatalf("owner cleanup did not join exactly once after the original stop timeout: %v", events)
	}
}

func TestWorkbenchRecoveryOwnerTeardownPreservesRefusalAndUnjoinedFailures(t *testing.T) {
	sentinel := errors.New("test.original_owner_failure")
	for _, mode := range []string{"missing-identity", "shutdown-refused", "rpc-close", "handle-wait", "held-process-alive"} {
		t.Run(mode, func(t *testing.T) {
			var events []string
			owner, probe := recoveryOwnerTeardownSubject(&events)
			switch mode {
			case "missing-identity":
				owner.attach = func(context.Context) (recoveryOwnerShutdownClient, error) { return nil, sentinel }
			case "shutdown-refused":
				probe.shutdownErr = sentinel
			case "rpc-close":
				probe.closeErr = sentinel
			case "handle-wait":
				probe.waitErr = sentinel
			case "held-process-alive":
				probe.keepAlive = true
			}
			err := owner.close(context.Background())
			if err == nil || mode != "held-process-alive" && !errors.Is(err, sentinel) {
				t.Fatalf("%s teardown swallowed its original admission/join error: %v", mode, err)
			}
			if strings.Contains(strings.Join(events, ","), "forbidden-terminate") {
				t.Fatal("failed owner admission/shutdown selected a direct process-kill alternative")
			}
			if mode == "missing-identity" && strings.Contains(strings.Join(events, ","), "owner.shutdown") {
				t.Fatal("an absent identity was allowed to issue shutdown")
			}
		})
	}
}
