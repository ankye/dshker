//go:build live && windows

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// This preflight never enables a blocking rule. It proves that the future
// scheduled action, not an SSH parent or a second manual Start, reclaims a
// disabled probe rule after its exact controller process was forcibly killed.
func TestWorkbenchRecoveryFirewallWatchdogCrashLive(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	// Outer ownership covers core startup, the fixed future watchdog deadline,
	// its observation window and verified cleanup. It never extends the guard.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	binary := os.Getenv("DSHKER_TEST_CORE_BINARY")
	state := stateDirectoryForCLI(t)
	core := recoveryStartServe(t, binary, []string{"serve", "--state", state, "--data", t.TempDir(), "--catalog", t.TempDir()})
	controller := recoveryStartFirewall(t, ctx, binary, core.cmd.Process.Pid, os.Getpid())
	command := exec.CommandContext(ctx, "powershell.exe", recoveryFirewallArguments(controller.script, controller.plan, "probe", "none", 0)...)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	must(t, command.Start())
	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = command.Wait()
		close(done)
	}()
	defer func() {
		select {
		case <-done:
		default:
			_ = command.Process.Kill()
			<-done
		}
	}()
	var ready struct {
		ID            string    `json:"id"`
		ControllerPID int       `json:"controllerPID"`
		At            time.Time `json:"at"`
	}
	readyDeadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(readyDeadline) {
		data, err := os.ReadFile(filepath.Join(controller.root, "probe-ready.json"))
		if err == nil {
			must(t, json.Unmarshal(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}), &ready))
			break
		}
		if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		select {
		case <-done:
			t.Fatalf("disabled probe controller ended before readiness: %v; %s", waitErr, output.String())
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
	if ready.ID != controller.id || ready.ControllerPID != command.Process.Pid || ready.At.IsZero() {
		t.Fatal("exact disabled probe controller identity was not acknowledged")
	}
	must(t, command.Process.Kill())
	<-done
	if waitErr == nil {
		t.Fatal("probe controller did not exhibit the requested forced termination")
	}
	t.Logf("watchdog-controller-killed controllerPID=%d corePID=%d id=%s deadline=%s ruleEnabled=false", ready.ControllerPID, core.cmd.Process.Pid, controller.id, controller.deadline.Format(time.RFC3339Nano))
	var receipt struct {
		ID          string    `json:"id"`
		Kind        string    `json:"kind"`
		At          time.Time `json:"at"`
		ActiveRules *int      `json:"activeRules"`
	}
	deadline := controller.deadline.Add(15 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(filepath.Join(controller.root, "watchdog-receipt.json"))
		if err == nil {
			must(t, json.Unmarshal(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}), &receipt))
			break
		}
		if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(250 * time.Millisecond):
		}
	}
	if receipt.ID != controller.id || receipt.Kind != "deadline-cleanup" || receipt.ActiveRules == nil || *receipt.ActiveRules != 0 || receipt.At.Before(controller.deadline) {
		t.Fatalf("future independent watchdog cleanup unproven: %+v", receipt)
	}
	must(t, controller.Close(ctx))
	t.Logf("watchdog-future-cleanup id=%s at=%s rules=0 controllerKilled=true manualSecondStart=false cleanupConfirmed=true", receipt.ID, receipt.At.Format(time.RFC3339Nano))
}
