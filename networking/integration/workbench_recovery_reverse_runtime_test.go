//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

const recoveryWindowsSubject = "dshkerd-dsh"

type recoveryWindowsInputs struct{ node, harness string }

func recoveryWindowsRuntimeInputs(t *testing.T) recoveryWindowsInputs {
	t.Helper()
	input := recoveryWindowsInputs{os.Getenv("DSHKER_TEST_WINDOWS_NODE"), os.Getenv("DSHKER_TEST_WINDOWS_HARNESS_ROOT")}
	for _, path := range []string{input.node, input.harness} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			t.Fatal("explicit normalized absolute DSHKER_TEST_WINDOWS_NODE and DSHKER_TEST_WINDOWS_HARNESS_ROOT required")
		}
	}
	info, err := os.Stat(input.node)
	must(t, err)
	if !info.Mode().IsRegular() {
		t.Fatal("explicit Windows Node is not a regular file")
	}
	must(t, harnessruntime.AssertBuiltEntry(input.harness))
	return input
}

// A desktop-attached observer owns callbacks, so it delegates only a scoped
// binding read to the actual production supervisor. Neither verb starts DSH.
type recoveryWindowsOwner struct {
	service, pair string
	core          atomic.Pointer[localrpc.Peer]
	allowed       atomic.Bool
	opens         atomic.Int64
	resumes       atomic.Int64
}

func (owner *recoveryWindowsOwner) call(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	var request struct {
		ServiceID string `json:"serviceId"`
		PairID    string `json:"pairId"`
	}
	if protocol.DecodeExact(payload, &request) != nil || request.ServiceID != owner.service || request.PairID != owner.pair {
		return nil, errors.New("p2p.identity_mismatch")
	}
	switch method {
	case "runtime.connect":
		owner.opens.Add(1)
	case "runtime.resume":
		owner.resumes.Add(1)
	default:
		return nil, errors.New("p2p.invalid_operation")
	}
	if !owner.allowed.Load() {
		return nil, errors.New("p2p.runtime_unavailable")
	}
	core := owner.core.Load()
	if core == nil {
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	raw, err := core.Call(ctx, "core.runtime_binding", struct{}{})
	if err != nil {
		return nil, err
	}
	var binding runtimebridge.Binding
	if err := protocol.DecodeExact(raw, &binding); err != nil {
		return nil, err
	}
	if _, err := binding.Endpoint(); err != nil {
		return nil, err
	}
	return binding, nil
}

type recoveryWindowsRuntime struct {
	launch     harnessruntime.LaunchView
	binding    runtimebridge.Binding
	project    string
	startCalls int
	cleanup    func()
}

func recoveryStartWindowsRuntime(t *testing.T, ctx context.Context, core *localrpc.Peer, input recoveryWindowsInputs) *recoveryWindowsRuntime {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	must(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	must(t, listener.Close())
	project := t.TempDir()
	project, err = filepath.EvalSymlinks(project)
	must(t, err)
	runtime := &recoveryWindowsRuntime{project: project}
	launchID := "recovery-" + protocol.NewID()
	logPath := filepath.Join(t.TempDir(), "dsh-web.log")
	diagnosed := false
	diagnose := func(view *harnessruntime.LaunchView) {
		if !diagnosed {
			diagnosed = true
			recoveryWindowsLaunchDiagnostics(t, core, recoveryWindowsSubject, launchID, logPath, view)
		}
	}
	// Register before runtime.start reaches the wire: even a lost or malformed
	// start response must leave an exact-launch cleanup ahead of parent.Close
	// and launch's core termination in the test's LIFO cleanup stack.
	t.Cleanup(func() {
		if runtime.cleanup != nil {
			runtime.cleanup()
			return
		}
		if t.Failed() {
			diagnose(nil)
		}
		recoveryCleanupWindowsRuntime(t, core, recoveryWindowsSubject, launchID)
		if t.Failed() {
			diagnose(nil)
		}
	})
	var started struct {
		Launch harnessruntime.LaunchView `json:"launch"`
	}
	raw, err := core.Call(ctx, "runtime.start", map[string]any{
		"launchId": launchID, "subjectId": recoveryWindowsSubject,
		"directory": input.harness, "profile": harnessruntime.ProfileNode,
		"nodeExecutable": input.node, "pnpmExecutable": "", "pnpmPrefixArguments": []string{},
		"pnpmResolutionError": "", "pnpmCommandSearchPath": "", "diagnosticsPatchPath": "",
		"port": harnessruntime.PortSetting{Mode: "fixed", Port: port}, "logPath": logPath,
	})
	runtime.startCalls++
	if err != nil {
		diagnose(nil)
		t.Fatalf("real Windows DSH start refused: %v", err)
	}
	if err := protocol.DecodeExact(raw, &started); err != nil {
		diagnose(nil)
		t.Fatalf("real Windows DSH start response was invalid: %v", err)
	}
	if started.Launch.PID <= 0 || started.Launch.SubjectID != recoveryWindowsSubject || started.Launch.LaunchID != launchID {
		diagnose(nil)
		t.Fatal("production supervisor did not own the real Windows DSH launch")
	}
	runtime.launch = started.Launch
	deadline, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		view, present, err := recoveryReadWindowsStatus(deadline, core, recoveryWindowsSubject)
		if err != nil || !present {
			diagnose(nil)
			t.Fatalf("real Windows DSH startup status was unavailable: present=%t code=%v", present, err)
		}
		if view.LaunchID != runtime.launch.LaunchID || view.PID != runtime.launch.PID {
			diagnose(&view)
			t.Fatal("Windows DSH startup changed its owned launch identity")
		}
		if view.State == harnessruntime.StateFailed || view.State == harnessruntime.StateStopped {
			diagnose(&view)
			t.Fatal("real Windows DSH failed before application readiness")
		}
		if view.State == harnessruntime.StateRunning && view.URL != "" {
			runtime.launch = view
			raw, err := core.Call(deadline, "core.runtime_binding", struct{}{})
			if err != nil {
				diagnose(&view)
				t.Fatalf("real Windows DSH binding read failed: %v", err)
			}
			if err := protocol.DecodeExact(raw, &runtime.binding); err != nil {
				diagnose(&view)
				t.Fatalf("real Windows DSH binding response was invalid: %v", err)
			}
			if runtime.binding.URL != view.URL || runtime.binding.Generation == 0 {
				diagnose(&view)
				t.Fatal("production runtime binding did not match the actual Windows DSH")
			}
			if err := runtimebridge.Probe(deadline, runtime.binding.URL); err != nil {
				diagnose(&view)
				t.Fatalf("real Windows DSH application probe failed: %s", recoveryRedactRuntimeDiagnostic(err.Error()))
			}
			t.Logf("windows-real-runtime pid=%d launch=%s generation=%d startCalls=%d profile=node", view.PID, view.LaunchID, runtime.binding.Generation, runtime.startCalls)
			return runtime
		}
		select {
		case <-time.After(25 * time.Millisecond):
		case <-deadline.Done():
			diagnose(&view)
			t.Fatal("real Windows DSH did not become application-ready within 30s")
		}
	}
}

func recoveryCleanupWindowsRuntime(t *testing.T, core *localrpc.Peer, subject, launchID string) {
	t.Helper()
	// Never inherit a failed scenario's cancellation. This channel remains owned
	// until its later parent.Close cleanup; no reconnection or other process is
	// adopted if it is unavailable.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	view, present, err := recoveryReadWindowsStatus(ctx, core, subject)
	if err != nil {
		t.Errorf("Windows runtime cleanup status failed launch=%s: %v", launchID, err)
		return
	}
	if !present {
		t.Logf("windows-runtime-cleanup subject=%s launch=%s present=false", subject, launchID)
		return
	}
	if view.SubjectID != subject || view.LaunchID != launchID || view.PID <= 0 {
		t.Errorf("Windows runtime cleanup refused an unowned subject/launch identity; expected launch=%s", launchID)
		return
	}
	pid := view.PID
	alreadyStopped := view.State == harnessruntime.StateStopped
	if !alreadyStopped {
		raw, stopErr := core.Call(ctx, "runtime.stop", map[string]any{"subjectId": subject})
		if stopErr != nil {
			t.Errorf("Windows runtime cleanup stop failed launch=%s pid=%d: %v", launchID, pid, stopErr)
		} else {
			var stopped struct {
				Launch harnessruntime.LaunchView `json:"launch"`
			}
			if protocol.DecodeExact(raw, &stopped) != nil || stopped.Launch.SubjectID != subject || stopped.Launch.LaunchID != launchID || stopped.Launch.PID != pid {
				t.Errorf("Windows runtime cleanup stop response lost its exact owned launch=%s pid=%d", launchID, pid)
			}
		}
		// Read back even after a stop-response error, while still reporting that
		// error. This is observation, not a retry or an alternate kill path.
		view, present, err = recoveryReadWindowsStatus(ctx, core, subject)
		if err != nil {
			t.Errorf("Windows runtime cleanup readback failed launch=%s pid=%d: %v", launchID, pid, err)
			return
		}
	}
	if !present || view.SubjectID != subject || view.LaunchID != launchID || view.PID != pid || view.Diagnostics.ExitCode == nil || view.State != harnessruntime.StateStopped && view.State != harnessruntime.StateFailed {
		t.Errorf("Windows runtime cleanup did not prove the exact owned child reaped launch=%s pid=%d", launchID, pid)
		return
	}
	t.Logf("windows-runtime-cleanup subject=%s launch=%s pid=%d state=%s reaped=true alreadyStopped=%t", subject, launchID, pid, view.State, alreadyStopped)
}

func recoveryReadWindowsStatus(ctx context.Context, core *localrpc.Peer, subject string) (harnessruntime.LaunchView, bool, error) {
	raw, err := core.Call(ctx, "runtime.status", map[string]any{"subjectId": subject})
	if err != nil {
		return harnessruntime.LaunchView{}, false, err
	}
	return recoveryDecodeWindowsStatus(raw)
}

func recoveryDecodeWindowsStatus(raw json.RawMessage) (harnessruntime.LaunchView, bool, error) {
	var presence struct {
		Present bool `json:"present"`
	}
	// The production decoder treats json tags literally, including options.
	// Select the two actual envelope variants first, then validate each exact
	// shape with option-free tags. Missing true.launch is never accepted.
	if err := protocol.Decode(raw, &presence); err != nil {
		return harnessruntime.LaunchView{}, false, err
	}
	if !presence.Present {
		if err := protocol.DecodeExact(raw, &presence); err != nil {
			return harnessruntime.LaunchView{}, false, err
		}
		return harnessruntime.LaunchView{}, false, nil
	}
	var status struct {
		Present bool                      `json:"present"`
		Launch  harnessruntime.LaunchView `json:"launch"`
	}
	if err := protocol.DecodeExact(raw, &status); err != nil {
		return harnessruntime.LaunchView{}, false, err
	}
	return status.Launch, true, nil
}

func recoveryWindowsStatus(t *testing.T, ctx context.Context, core *localrpc.Peer) harnessruntime.LaunchView {
	t.Helper()
	view, present, err := recoveryReadWindowsStatus(ctx, core, recoveryWindowsSubject)
	must(t, err)
	if !present {
		t.Fatal("production supervisor lost its actual Windows DSH launch record")
	}
	return view
}

func recoveryWindowsLaunchDiagnostics(t *testing.T, core *localrpc.Peer, subject, launchID, logPath string, known *harnessruntime.LaunchView) {
	t.Helper()
	if known == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		view, present, err := recoveryReadWindowsStatus(ctx, core, subject)
		if err != nil || !present {
			t.Logf("windows-runtime-launch-diagnostic launch=%s present=%t code=%v", launchID, present, err)
		} else {
			known = &view
		}
	}
	if known != nil {
		if known.SubjectID != subject || known.LaunchID != launchID {
			t.Logf("windows-runtime-launch-diagnostic launch=%s refusedUnownedStatus=true", launchID)
		} else {
			t.Logf("windows-runtime-launch-diagnostic launch=%s pid=%d state=%s diagnostics=%s", launchID, known.PID, known.State, recoveryJSON(t, known.Diagnostics))
			if known.Failure != nil {
				t.Logf("windows-runtime-launch-error code=%s message=%s", recoveryRedactRuntimeDiagnostic(known.Failure.Code), recoveryRedactRuntimeDiagnostic(known.Failure.Message))
			}
		}
	}
	file, err := os.Open(logPath)
	if err != nil {
		t.Logf("windows-runtime-startup-log unavailable launch=%s code=%s", launchID, recoveryRedactRuntimeDiagnostic(err.Error()))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Log("windows-runtime-startup-log stat failed")
		return
	}
	const limit = int64(16 << 10)
	if info.Size() > limit {
		if _, err := file.Seek(info.Size()-limit, io.SeekStart); err != nil {
			t.Log("windows-runtime-startup-log seek failed")
			return
		}
	}
	body, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		t.Log("windows-runtime-startup-log read failed")
		return
	}
	t.Logf("windows-runtime-startup-log launch=%s bytes=%d truncated=%t\n%s", launchID, len(body), info.Size() > limit, recoveryRedactRuntimeDiagnosticTail(string(body), info.Size() > limit))
}

var (
	recoveryDiagnosticANSI       = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	recoveryDiagnosticPEM        = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----`)
	recoveryDiagnosticSensitive  = regexp.MustCompile(`(?i)token|secret|password|api[-_ ]?key|private[-_ ]?key|authorization|cookie|credential|\bbearer\b`)
	recoveryDiagnosticEncoded    = regexp.MustCompile(`^[A-Za-z0-9+/=]{40,}$`)
	recoveryDiagnosticCredential = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`)
	recoveryDiagnosticURL        = regexp.MustCompile(`(?i)https?://[^\s"'<>]+`)
)

func recoveryRedactRuntimeDiagnostic(value string) string {
	value = recoveryDiagnosticANSI.ReplaceAllString(value, "")
	value = recoveryDiagnosticPEM.ReplaceAllString(value, "[redacted encoded material]")
	lines := strings.Split(value, "\n")
	for index, line := range lines {
		if recoveryDiagnosticSensitive.MatchString(line) || recoveryDiagnosticEncoded.MatchString(strings.TrimSpace(line)) {
			lines[index] = "[redacted credential line]"
		} else {
			line = recoveryDiagnosticCredential.ReplaceAllString(line, "[redacted credential]")
			lines[index] = recoveryDiagnosticURL.ReplaceAllString(line, "[redacted URL]")
		}
	}
	return strings.Join(lines, "\n")
}

func recoveryRedactRuntimeDiagnosticTail(value string, truncated bool) string {
	if !truncated {
		return recoveryRedactRuntimeDiagnostic(value)
	}
	// An arbitrary tail offset can begin after a sensitive line's keyword.
	// Conservatively omit that first line, even if the offset was line-aligned.
	const omitted = "[truncated partial line omitted]"
	newline := strings.IndexByte(value, '\n')
	if newline < 0 {
		return omitted
	}
	return omitted + "\n" + recoveryRedactRuntimeDiagnostic(value[newline+1:])
}

func TestWorkbenchRecoveryRuntimeDiagnosticRedaction(t *testing.T) {
	sentinel := strings.Repeat("S", 64)
	for _, prefix := range []string{"Bearer ", "bEaReR\t", "diagnostic: Bearer "} {
		t.Run(strings.ReplaceAll(prefix, "\t", "tab"), func(t *testing.T) {
			got := recoveryRedactRuntimeDiagnostic(prefix + sentinel)
			if strings.Contains(got, sentinel) {
				t.Fatal("diagnostic retained the sentinel credential")
			}
		})
	}
	const failure = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-app-boot'"
	if got := recoveryRedactRuntimeDiagnostic(failure); got != failure {
		t.Fatal("diagnostic removed the actual module failure")
	}
}

func TestWorkbenchRecoveryRuntimeDiagnosticTailRedaction(t *testing.T) {
	const fragment = "SENTINEL_PARTIAL_LINE_WITH_NO_SENSITIVE_LABEL"
	const failure = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-app-boot'"
	for name, input := range map[string]string{
		"next-complete-line": fragment + "\n" + failure,
		"no-complete-line":   fragment,
		"windows-crlf":       fragment + "\r\n" + failure,
	} {
		t.Run(name, func(t *testing.T) {
			got := recoveryRedactRuntimeDiagnosticTail(input, true)
			if strings.Contains(got, fragment) || !strings.HasPrefix(got, "[truncated partial line omitted]") {
				t.Fatal("diagnostic retained a truncated sentinel fragment")
			}
			if strings.Contains(input, failure) && !strings.Contains(got, failure) {
				t.Fatal("diagnostic removed the complete module failure after the partial line")
			}
		})
	}
	if got := recoveryRedactRuntimeDiagnosticTail(failure, false); got != failure {
		t.Fatal("untruncated diagnostic lost its first complete line")
	}
	if got := recoveryRedactRuntimeDiagnosticTail(fragment+"\nBearer "+strings.Repeat("S", 64), true); strings.Contains(got, strings.Repeat("S", 64)) {
		t.Fatal("tail diagnostic retained a later sentinel credential")
	}
}

func (runtime *recoveryWindowsRuntime) assertRunning(t *testing.T, ctx context.Context, core *localrpc.Peer) {
	t.Helper()
	view := recoveryWindowsStatus(t, ctx, core)
	if view.State != harnessruntime.StateRunning || view.PID != runtime.launch.PID || view.LaunchID != runtime.launch.LaunchID || view.URL != runtime.binding.URL || runtime.startCalls != 1 {
		t.Fatal("reverse recovery replaced or started the Windows DSH runtime")
	}
}

func (runtime *recoveryWindowsRuntime) stop(t *testing.T, ctx context.Context, core *localrpc.Peer) {
	t.Helper()
	callCore(t, ctx, core, "runtime.stop", map[string]any{"subjectId": recoveryWindowsSubject})
	runtime.assertStopped(t, ctx, core)
}

func (runtime *recoveryWindowsRuntime) assertStopped(t *testing.T, ctx context.Context, core *localrpc.Peer) {
	t.Helper()
	view := recoveryWindowsStatus(t, ctx, core)
	if view.State != harnessruntime.StateStopped || view.PID != runtime.launch.PID || view.LaunchID != runtime.launch.LaunchID || view.Diagnostics.ExitCode == nil || runtime.startCalls != 1 {
		t.Fatal("original Windows DSH child was not reaped or was automatically replaced")
	}
	if _, err := core.Call(ctx, "core.runtime_binding", struct{}{}); err == nil || err.Error() != "p2p.runtime_unavailable" {
		t.Fatal("stopped Windows DSH retained a usable binding")
	}
}
