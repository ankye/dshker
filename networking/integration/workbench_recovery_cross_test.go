//go:build live

package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Contains only newly enrolled test credentials. No installed account, catalog,
// runtime token, or private key from the user is read by either role.
type recoveryCrossConfig struct {
	Version                int                      `json:"version"`
	Cycles                 int                      `json:"cycles"`
	TestPhase              string                   `json:"testPhase"`
	NetworkFaultCase       string                   `json:"networkFaultCase"`
	ApplicationIdleSeconds int                      `json:"applicationIdleSeconds"`
	ResourceDeadlineUnix   int64                    `json:"resourceDeadlineUnix"`
	Dialer                 childConfig              `json:"dialer"`
	Session                controlplane.UserSession `json:"session"`
	Remote                 controlplane.Device      `json:"remote"`
	Project                string                   `json:"project"`
	ControlURL             string                   `json:"controlUrl"`
	ControlSecret          string                   `json:"controlSecret"`
}

type recoveryCrossCommand struct {
	op      string
	project string
	reply   chan recoveryCrossStatus
	wrote   chan struct{}
}

type recoveryCrossStatus struct {
	Active       bool                   `json:"active"`
	Available    bool                   `json:"available"`
	RuntimeAlive bool                   `json:"runtimeAlive"`
	OwnerCalls   int64                  `json:"ownerCalls"`
	ResumeCalls  int64                  `json:"resumeCalls"`
	RuntimePID   int                    `json:"runtimePid"`
	Reverse      *recoveryReverseStatus `json:"reverse,omitempty"`
	Network      *recoveryNetworkProof  `json:"network,omitempty"`
	Sealed       *recoverySealedProof   `json:"sealed,omitempty"`
}

type recoveryDiagnosticScope struct {
	ServiceID  string `json:"serviceId"`
	PairID     string `json:"pairId"`
	AttemptID  string `json:"attemptId"`
	Generation uint64 `json:"generation"`
}

type recoveryCrossDiagnostic struct {
	Scope           recoveryDiagnosticScope       `json:"scope"`
	MacLastObserved recoveryMacDiagnosticSnapshot `json:"macLastObserved"`
	Stack           string                        `json:"stack"`
	Truncated       bool                          `json:"truncated"`
}

// Mac host: writes a test-owned configuration for the Windows test process and
// waits for that process to drive controlled loss of this test manager only.
func TestWorkbenchRecoveryCrossHost(t *testing.T) {
	phase := os.Getenv("DSHKER_TEST_CROSS_PHASE")
	faultCase := os.Getenv("DSHKER_TEST_CROSS_NETWORK_FAULT_CASE")
	must(t, recoveryValidateCrossPhase(phase, faultCase))
	cycles, err := strconv.Atoi(os.Getenv("DSHKER_TEST_CROSS_CYCLES"))
	if err != nil || cycles < 3 || cycles > 20 {
		t.Fatal("explicit integer DSHKER_TEST_CROSS_CYCLES in range 3..20 required")
	}
	idleSeconds, err := strconv.Atoi(os.Getenv("DSHKER_TEST_CROSS_APPLICATION_IDLE_SECONDS"))
	if err != nil || idleSeconds < 60 || idleSeconds > 43200 {
		t.Fatal("explicit integer DSHKER_TEST_CROSS_APPLICATION_IDLE_SECONDS in range 60..43200 required")
	}
	bindIP := os.Getenv("DSHKER_TEST_CROSS_BIND_IP")
	ip := net.ParseIP(bindIP)
	if ip == nil || ip.IsLoopback() || ip.To4() == nil {
		t.Fatal("explicit reachable IPv4 DSHKER_TEST_CROSS_BIND_IP required")
	}
	configPath := recoveryCrossConfigPath(t)
	ownerBudget := recoveryScenarioLifetime(cycles, idleSeconds, phase, faultCase) + 3*time.Minute
	resourceDeadline := time.Now().Add(ownerBudget + 15*time.Minute).Truncate(time.Second)
	runtimeURL, runtimeProcess := startRealDSH(t)
	project, err := filepath.EvalSymlinks(runtimeProcess.cmd.Dir)
	must(t, err)
	f := newFixture(t)
	recoveryRebindFixture(t, f, ip, resourceDeadline)
	recoveryCheckResources(t, f, resourceDeadline)
	ctx, cancel := context.WithTimeout(f.ctx, ownerBudget)
	defer cancel()
	var calls, resumes atomic.Int64
	var available atomic.Bool
	available.Store(true)
	reverseEvents := make(chan peersession.State, 4096)
	var auto recoveryNetworkAutoOwner
	var diagnosticObservation recoveryMacDiagnosticObservation
	if phase == "network-fault" || phase == "program-pause" || phase == "core-crash" || phase == "duplex" {
		auto = recoveryMacAutoOwner(t, ctx, f, reverseEvents)
	}
	newRemote := func() *peersession.Manager {
		emit := func(state peersession.State) { reverseEvents <- state }
		wake := func(string) {}
		if auto != nil {
			emit = auto.Observe
			wake = auto.Wake
		}
		observedEmit := emit
		emit = func(state peersession.State) {
			diagnosticObservation.observe(f.config[0].Device.DeviceID, state)
			observedEmit(state)
		}
		manager := recoveryRemoteObserved(t, ctx, f, runtimeURL, &available, &calls, &resumes, emit, wake)
		if auto != nil {
			auto.BindManager(t, manager)
		}
		return manager
	}
	remote := newRemote()
	var reverse *recoveryReverseBrowser
	var network *recoveryNetworkHost
	var sealed *recoverySealedProof
	var idleReaderDone <-chan struct{}
	status := func() recoveryCrossStatus {
		alive := true
		select {
		case <-runtimeProcess.done:
			alive = false
		default:
		}
		answer := recoveryCrossStatus{Active: remote != nil, Available: available.Load(), RuntimeAlive: alive, OwnerCalls: calls.Load(), ResumeCalls: resumes.Load(), RuntimePID: runtimeProcess.cmd.Process.Pid}
		if reverse != nil {
			answer.Reverse = reverse.status()
		}
		if network != nil {
			answer.Network = network.proof()
		}
		answer.Sealed = sealed
		return answer
	}
	defer func() {
		if auto != nil {
			auto.Close()
		}
		if remote != nil {
			remote.Close()
		}
	}()
	listener, err := net.Listen("tcp", net.JoinHostPort(bindIP, "0"))
	must(t, err)
	commands := make(chan recoveryCrossCommand)
	secret := protocol.NewID() + protocol.NewID()
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
			http.Error(w, "test-control.unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/diagnostic" {
			var scope recoveryDiagnosticScope
			body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
			if err != nil || protocol.DecodeExact(body, &scope) != nil || !recoveryDiagnosticAdmitted(scope, f.authority.ServiceID, f.config[1].Device.DeviceID) {
				http.Error(w, "test-control.invalid_diagnostic_scope", http.StatusBadRequest)
				return
			}
			// Do not queue behind /drop or /resume: this must still capture a
			// blocked manager. Only this test process's stacks are inspected.
			stack := make([]byte, 1<<20)
			size := runtime.Stack(stack, true)
			t.Logf("cross-host-diagnostic service=%s pair=%s attempt=%s generation=%d capturedAt=%s truncated=%t", scope.ServiceID, scope.PairID, scope.AttemptID, scope.Generation, time.Now().UTC().Format(time.RFC3339Nano), size == len(stack))
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(recoveryCrossDiagnostic{Scope: scope, MacLastObserved: diagnosticObservation.snapshot(f.config[0].Device.DeviceID, scope), Stack: string(stack[:size]), Truncated: size == len(stack)})
			return
		}
		if r.URL.Path != "/drop" && r.URL.Path != "/resume" && r.URL.Path != "/finish" && r.URL.Path != "/deny-workbench" && r.URL.Path != "/allow-workbench" && r.URL.Path != "/stop-runtime" && r.URL.Path != "/invalidate-runtime" && r.URL.Path != "/reverse-open" && r.URL.Path != "/reverse-readback" && r.URL.Path != "/reverse-await-ready" && r.URL.Path != "/reverse-await-refused" && r.URL.Path != "/reverse-idle-begin" && r.URL.Path != "/reverse-idle-end" && r.URL.Path != "/reverse-idle-progress" && r.URL.Path != "/reverse-network-arm" && r.URL.Path != "/reverse-network-state" && r.URL.Path != "/reverse-network-readback" && r.URL.Path != "/reverse-seal" {
			http.Error(w, "test-control.invalid_operation", http.StatusBadRequest)
			return
		}
		command := recoveryCrossCommand{op: r.URL.Path, reply: make(chan recoveryCrossStatus, 1), wrote: make(chan struct{})}
		if r.URL.Path == "/reverse-open" {
			var request struct {
				Project string `json:"project"`
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
			if err != nil || protocol.DecodeExact(body, &request) != nil || len(request.Project) < 3 || request.Project[1] != ':' || request.Project[2] != '\\' {
				http.Error(w, "test-control.invalid_windows_project", http.StatusBadRequest)
				return
			}
			command.project = request.Project
		}
		select {
		case commands <- command:
		case <-ctx.Done():
			return
		}
		select {
		case answer := <-command.reply:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(answer)
			w.(http.Flusher).Flush()
			close(command.wrote)
		case <-ctx.Done():
		}
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	config := recoveryCrossConfig{
		Version: 2, Cycles: cycles, TestPhase: phase, NetworkFaultCase: faultCase, ApplicationIdleSeconds: idleSeconds, ResourceDeadlineUnix: resourceDeadline.Unix(), Dialer: f.config[0], Session: f.userSession, Remote: f.config[1].Device, Project: project,
		ControlURL: "http://" + listener.Addr().String(), ControlSecret: secret,
	}
	encoded, err := json.Marshal(config)
	must(t, err)
	must(t, os.WriteFile(configPath, encoded, 0o600))
	t.Logf("cross-host-ready config=%s service=%s dialer=%s remote=%s runtimePid=%d cycles=%d phase=%s", configPath, f.authority.ServiceID, f.config[0].Device.DeviceID, f.config[1].Device.DeviceID, runtimeProcess.cmd.Process.Pid, cycles, phase)
	for {
		select {
		case command := <-commands:
			switch command.op {
			case "/drop":
				if phase != "forward-stress" || remote == nil || reverse != nil {
					t.Fatal("test control attempted to drop an absent manager")
				}
				remote.Close()
				remote = nil
			case "/resume":
				if phase != "forward-stress" || remote != nil {
					t.Fatal("test control attempted to replace an active manager")
				}
				remote = newRemote()
			case "/invalidate-runtime":
				if phase != "duplex" || remote == nil {
					t.Fatal("directional invalidation requires the duplex phase's existing manager")
				}
				remote.InvalidateRuntime(1)
			case "/reverse-open":
				if phase != "duplex" && phase != "network-fault" && phase != "program-pause" && phase != "core-crash" || reverse != nil || remote == nil {
					t.Fatal("reverse workbench must be explicitly opened exactly once on the existing manager")
				}
				reverse = recoveryOpenReverse(t, ctx, remote, reverseEvents, f.config[0].Device.DeviceID, command.project)
				if auto != nil {
					auto.Start(t, reverse.current)
					if phase == "core-crash" {
						network = recoveryNewCrashHost(t, reverse, auto)
					} else if phase == "network-fault" {
						network = recoveryNewNetworkHost(t, reverse, auto, faultCase)
					} else if phase == "program-pause" {
						plan, err := recoveryProgramCasePlan(faultCase)
						must(t, err)
						network = recoveryNewFaultHost(t, reverse, auto, plan)
					}
				}
			case "/reverse-network-arm", "/reverse-network-state", "/reverse-network-readback":
				if phase != "network-fault" && phase != "program-pause" && phase != "core-crash" || network == nil {
					t.Fatal("network control requires its independently opened automatic-owner phase")
				}
				network.control(t, ctx, command.op)
			case "/reverse-seal":
				if network == nil || !network.readback || sealed != nil {
					t.Fatal("business sealing requires its completed current automatic readback")
				}
				accepted := reverse.current
				if network.observe(t) != accepted {
					t.Fatal("business sealing was superseded by a different automatic attempt")
				}
				must(t, reverse.stream.SealCloseJoin())
				sealed = &recoverySealedProof{State: reverse.current, WSID: reverse.wsID, WorkspaceID: reverse.workspace.ID, SessionID: reverse.session, ClosedAndJoined: true}
				t.Logf("business-sealed direction=mac-to-windows pair=%s attempt=%s generation=%d ws=%s workspace=%s session=%s closedAndJoined=true", reverse.pair, reverse.current.AttemptID, reverse.current.Generation, reverse.wsID, reverse.workspace.ID, reverse.session)
			case "/reverse-readback", "/reverse-await-ready", "/reverse-await-refused":
				if reverse == nil {
					t.Fatal("reverse workbench was not explicitly opened")
				}
				if command.op == "/reverse-readback" {
					reverse.readback(t, ctx)
				} else {
					if phase != "duplex" || auto == nil {
						t.Fatal("automatic reverse recovery requires its production engine owner")
					}
					stage := "ready"
					if command.op == "/reverse-await-refused" {
						stage = "connected"
					}
					reverse.awaitRecovery(t, ctx, auto, stage)
				}
			case "/reverse-idle-begin", "/reverse-idle-end", "/reverse-idle-progress":
				if phase != "duplex" || reverse == nil || !status().RuntimeAlive {
					t.Fatal("application idle requires the duplex phase's original live runtime")
				}
				if command.op == "/reverse-idle-begin" {
					reverse.browser.requireCookieLifetime(t, resourceDeadline.Unix())
					reverse.beginIdle(t, ctx, idleSeconds, runtimeProcess.cmd.Process.Pid)
					idleReaderDone = reverse.stream.done
				} else if command.op == "/reverse-idle-progress" {
					reverse.progressIdle(t, runtimeProcess.cmd.Process.Pid)
				} else {
					idleReaderDone = nil
					reverse.endIdle(t, ctx, idleSeconds)
				}
			case "/deny-workbench":
				available.Store(false)
			case "/allow-workbench":
				if !status().RuntimeAlive {
					t.Fatal("test control cannot allow a stopped DSH runtime")
				}
				available.Store(true)
			case "/stop-runtime":
				runtimeProcess.stop(t, false)
				available.Store(false)
				if remote != nil {
					remote.InvalidateRuntime(1)
				}
			case "/finish":
				if (phase == "network-fault" || phase == "program-pause" || phase == "core-crash") && sealed == nil {
					t.Fatal("automatic case cannot finish before strict identity-bearing carrier sealing")
				}
				command.reply <- status()
				select {
				case <-command.wrote:
				case <-ctx.Done():
					t.Fatal("cross-machine finish response was not delivered")
				}
				t.Logf("cross-host-finished runtimePid=%d ownerCalls=%d resumeCalls=%d", runtimeProcess.cmd.Process.Pid, calls.Load(), resumes.Load())
				return
			}
			t.Logf("cross-host-control op=%s runtimePid=%d ownerCalls=%d", command.op, runtimeProcess.cmd.Process.Pid, calls.Load())
			command.reply <- status()
		case <-idleReaderDone:
			reverse.stream.healthy(t)
			t.Fatal("original reverse WS reader ended during application idle")
		case <-ctx.Done():
			t.Fatal("cross-machine client did not complete within the test owner lifetime")
		}
	}
}

// Windows client: real dshkerd serve and its production periodic loop own recovery.
// The observer never sends a reconciliation, retry, or second explicit connect.
func TestWorkbenchRecoveryCrossClient(t *testing.T) {
	recoveryRequireIsolatedCore(t)
	data, err := os.ReadFile(recoveryCrossConfigPath(t))
	must(t, err)
	var config recoveryCrossConfig
	must(t, protocol.DecodeExact(data, &config))
	if config.Version != 2 || config.ControlURL == "" || config.ControlSecret == "" || config.Project == "" || config.Remote.DeviceID == "" {
		t.Fatal("incomplete explicit cross-machine test configuration")
	}
	if config.Cycles < 3 || config.Cycles > 20 {
		t.Fatal("explicit integer cross-machine cycles in range 3..20 required")
	}
	if config.ApplicationIdleSeconds < 60 || config.ApplicationIdleSeconds > 43200 {
		t.Fatal("explicit integer applicationIdleSeconds in range 60..43200 required")
	}
	must(t, recoveryValidateCrossPhase(config.TestPhase, config.NetworkFaultCase))
	if config.ResourceDeadlineUnix < time.Now().Add(recoveryScenarioLifetime(config.Cycles, config.ApplicationIdleSeconds, config.TestPhase, config.NetworkFaultCase)).Unix() {
		t.Fatal("explicit resourceDeadlineUnix does not cover the requested real idle")
	}
	must(t, recoveryValidateInitialSession(config.Session, config.ResourceDeadlineUnix))
	recoveryCheckCertificateLifetimes(t, config.Dialer.Root, config.Dialer.Authority, []controlplane.Device{config.Dialer.Device, config.Remote}, time.Unix(config.ResourceDeadlineUnix, 0))
	ctx, cancel := context.WithTimeout(context.Background(), recoveryScenarioLifetime(config.Cycles, config.ApplicationIdleSeconds, config.TestPhase, config.NetworkFaultCase))
	defer cancel()
	f := &realCoordinator{ctx: ctx, root: config.Dialer.Root, endpoints: config.Dialer.Endpoints, authority: config.Dialer.Authority, userSession: config.Session}
	f.config[0] = config.Dialer
	f.config[1].Device = config.Remote
	events := make(chan peersession.State, 4096)
	pairID := config.Remote.DeviceID
	var core *localrpc.Peer
	var localCalls atomic.Int64
	var owner *recoveryWindowsOwner
	var windowsRuntime *recoveryWindowsRuntime
	var reverseInitial *recoveryReverseStatus
	var owned recoveryOwnedCore
	runtimePID := 0
	trace := recoveryInitialTrace{phase: "initial_core_start"}
	defer func() {
		// Fatal from an existing setup helper uses Goexit; only an already
		// failed test may enter this independent read-only diagnostic owner.
		if trace.accepted || !t.Failed() {
			return
		}
		scope := recoveryInitialDiagnosticScope(f.authority.ServiceID, pairID, core, owned.Initial)
		trace.diagnose(t.Failed(), func(failure recoveryInitialFailure) {
			t.Logf("cross-initial-failure acceptance=false sealed=true %s service=%s pair=%s attempt=%s generation=%d scopeKnown=%t diagnosticBudget=10s", failure.Error(), scope.ServiceID, scope.PairID, scope.AttemptID, scope.Generation, recoveryDiagnosticExact(scope))
		}, func(diagnostic context.Context) {
			recoveryCrossCollectStack(t, diagnostic, config, scope)
			recoveryCoreCurrentDiagnostic(t, diagnostic, core, scope)
		})
	}()
	if config.TestPhase == "forward-stress" {
		owned = recoveryCoreOwned(t, f, events, func(context.Context, string, json.RawMessage) (any, error) {
			localCalls.Add(1)
			return nil, errors.New("p2p.unexpected_runtime_owner")
		})
		core = owned.Peer
	} else {
		windowsInputs := recoveryWindowsRuntimeInputs(t)
		owner = &recoveryWindowsOwner{service: f.authority.ServiceID, pair: pairID}
		owned = recoveryCoreOwned(t, f, events, owner.call)
		core = owned.Peer
		owner.core.Store(core)
		owner.allowed.Store(true)
		trace.phase = "initial_runtime_start"
		windowsRuntime = recoveryStartWindowsRuntime(t, ctx, core, windowsInputs)
		if config.TestPhase == "core-crash" {
			t.Log("core-crash-scenario injectionPerformed=false stage=initial-workbench")
		}
	}
	initial, cancelInitial := context.WithTimeout(ctx, 25*time.Second)
	defer cancelInitial()
	var openReverse func() error
	if windowsRuntime != nil {
		openReverse = func() error {
			reverseAnswer := recoveryCrossControlPayload(t, initial, config, "/reverse-open", map[string]any{"project": windowsRuntime.project})
			reverseInitial = recoveryRequireReverse(t, reverseAnswer, "ready", windowsRuntime.binding.Generation)
			runtimePID = reverseAnswer.RuntimePID
			t.Logf("reverse-initial-readback phase=%s service=%s pair=%s attempt=%s generation=%d runtimeGeneration=%d workspace=%s session=%s originalWS=%s windowsRuntimePid=%d", config.TestPhase, f.authority.ServiceID, reverseInitial.State.PairID, reverseInitial.State.AttemptID, reverseInitial.State.Generation, reverseInitial.State.RuntimeGeneration, reverseInitial.WorkspaceID, reverseInitial.SessionID, reverseInitial.WSID, windowsRuntime.launch.PID)
			return nil
		}
	}
	trace.phase = "initial_transport"
	first, err := recoveryInitializeCross(initial, core, trace.call(core.Call), f, owned.Initial, config.TestPhase, trace.reverse(openReverse))
	if err == nil {
		err = initial.Err()
	}
	cancelInitial()
	if err != nil {
		trace.err = err
		t.Error(recoveryInitialFailure{Phase: trace.phase, cause: err})
		return
	}
	trace.accepted = true
	if config.TestPhase == "core-crash" {
		recoveryCoreCrashCase(t, ctx, config, f, owned, events, owner, windowsRuntime, reverseInitial, recoveryWindowsRuntimeInputs(t), runtimePID)
		return
	}
	waitState := func(after uint64, stage string) peersession.State {
		return recoveryStateWithDiagnostics(t, ctx, events, pairID, after, stage, func(last peersession.State) {
			recoveryCrossFailureDiagnostics(t, ctx, config, core, events, pairID, last)
		})
	}
	browser := recoveryOpenBrowser(t, ctx, first.URL)
	workspace, sessionID := browser.createSession(t, ctx, config.Project)
	stream := browser.readback(t, ctx, workspace, sessionID)
	previous := first.State
	seen := map[string]bool{first.State.AttemptID: true}
	if config.TestPhase == "network-fault" {
		recoveryNetworkFaultCase(t, ctx, config, f, owned, events, owner, windowsRuntime, reverseInitial, browser, workspace, sessionID, stream, first, runtimePID)
		return
	}
	if config.TestPhase == "program-pause" {
		recoveryProgramPauseCase(t, ctx, config, f, owned, events, owner, windowsRuntime, reverseInitial, browser, workspace, sessionID, stream, first, runtimePID)
		return
	}
	if config.TestPhase == "duplex" {
		recoveryDuplexCase(t, ctx, config, f, core, events, owner, windowsRuntime, reverseInitial, browser, workspace, sessionID, stream, first, previous, seen, runtimePID, waitState)
		return
	}
	for cycle := 1; cycle <= config.Cycles; cycle++ {
		dropped := recoveryCrossControl(t, ctx, config, "/drop")
		if dropped.Active || dropped.RuntimePID <= 0 || runtimePID != 0 && runtimePID != dropped.RuntimePID {
			t.Fatal("cross-machine loss changed the independent DSH runtime owner")
		}
		runtimePID = dropped.RuntimePID
		waitDisconnected(t, ctx, events, previous.AttemptID)
		browser.detached(t, ctx)
		assertRecoveryStreamClosed(t, ctx, stream)
		resumed := recoveryCrossControl(t, ctx, config, "/resume")
		if !resumed.Active || resumed.RuntimePID != runtimePID {
			t.Fatal("test manager recovery restarted the actual DSH")
		}
		current := waitState(previous.Generation, "ready")
		if seen[current.AttemptID] || current.AttemptID == "" || current.RuntimeGeneration != 1 || recoveryEntry(t, ctx, core, f, current) != first.URL {
			t.Fatal("cross-machine recovery reused a stale identity or moved the original gateway")
		}
		seen[current.AttemptID] = true
		stream = browser.readback(t, ctx, workspace, sessionID)
		if localCalls.Load() != 0 {
			t.Fatal("cross-machine recovery activated the client's local DSH")
		}
		t.Logf("cross-recovery cycle=%d service=%s pair=%s attempt=%s generation=%d runtimeGeneration=%d runtimePid=%d sameGateway=true workspace=%s session=%s", cycle, f.authority.ServiceID, pairID, current.AttemptID, current.Generation, current.RuntimeGeneration, runtimePID, workspace.ID, sessionID)
		previous = current
	}
	recoveryForwardStressFinish(t, ctx, config, f, core, events, browser, workspace, sessionID, stream, first, previous, seen, runtimePID, &localCalls, waitState)
}

// This phase retains the original whole-manager-loss matrix. It never opens a
// reverse workbench; a separate role run owns all duplex identities and proof.
func recoveryForwardStressFinish(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, core *localrpc.Peer, events <-chan peersession.State, browser *recoveryBrowser, workspace recoveryWorkspace, session string, stream *recoveryWS, first peersession.Connected, previous peersession.State, seen map[string]bool, runtimePID int, localCalls *atomic.Int64, waitState func(uint64, string) peersession.State) {
	t.Helper()
	denied := recoveryCrossControl(t, ctx, config, "/deny-workbench")
	if denied.Available || !denied.RuntimeAlive || denied.OwnerCalls != 1 || denied.ResumeCalls != int64(config.Cycles) {
		t.Fatal("temporary refusal changed the actual DSH owner or initial resume count")
	}
	recoveryCrossControl(t, ctx, config, "/drop")
	waitDisconnected(t, ctx, events, previous.AttemptID)
	browser.detached(t, ctx)
	assertRecoveryStreamClosed(t, ctx, stream)
	recoveryCrossControl(t, ctx, config, "/resume")
	refused := waitState(previous.Generation, "connected")
	recoveryForwardFresh(t, seen, refused)
	if refused.Error != "p2p.runtime_unavailable" || refused.RuntimeGeneration != 0 {
		t.Fatalf("temporary resume refusal lost its owning state: %s", recoveryJSON(t, refused))
	}
	browser.detached(t, ctx)
	t.Logf("cross-resume-refusal service=%s pair=%s attempt=%s generation=%d error=%s runtimePid=%d trigger=serve-periodic phase=forward-stress", f.authority.ServiceID, refused.PairID, refused.AttemptID, refused.Generation, refused.Error, runtimePID)
	allowed := recoveryCrossControl(t, ctx, config, "/allow-workbench")
	if !allowed.Available || !allowed.RuntimeAlive || allowed.RuntimePID != runtimePID || allowed.OwnerCalls != 1 || allowed.ResumeCalls <= denied.ResumeCalls {
		t.Fatal("resume refusal called the cold owner or changed the real DSH")
	}
	recovered := waitState(refused.Generation, "ready")
	recoveryForwardFresh(t, seen, recovered)
	if recovered.RuntimeGeneration != 1 || recoveryEntry(t, ctx, core, f, recovered) != first.URL {
		t.Fatal("periodic retry after refusal did not recover the original gateway")
	}
	stream = browser.readback(t, ctx, workspace, session)
	t.Logf("cross-refusal-recovered service=%s pair=%s attempt=%s generation=%d sameGateway=true workspace=%s session=%s trigger=serve-periodic phase=forward-stress", f.authority.ServiceID, recovered.PairID, recovered.AttemptID, recovered.Generation, workspace.ID, session)
	stopped := recoveryCrossControl(t, ctx, config, "/stop-runtime")
	if stopped.RuntimeAlive || stopped.Available || stopped.RuntimePID != runtimePID || stopped.OwnerCalls != 1 {
		t.Fatal("test-owned DSH did not stop at its original PID")
	}
	waitDisconnected(t, ctx, events, recovered.AttemptID)
	browser.detached(t, ctx)
	assertRecoveryStreamClosed(t, ctx, stream)
	stoppedState := waitState(recovered.Generation, "connected")
	recoveryForwardFresh(t, seen, stoppedState)
	if stoppedState.Error != "p2p.runtime_unavailable" || stoppedState.RuntimeGeneration != 0 || localCalls.Load() != 0 {
		t.Fatalf("periodic recovery misreported the stopped runtime: %s", recoveryJSON(t, stoppedState))
	}
	browser.detached(t, ctx)
	finished := recoveryCrossControl(t, ctx, config, "/finish")
	if finished.RuntimePID != runtimePID || finished.RuntimeAlive || finished.OwnerCalls != 1 || finished.ResumeCalls <= stopped.ResumeCalls {
		t.Fatal("stopped DSH was activated by automatic recovery")
	}
	t.Logf("cross-stopped-runtime service=%s pair=%s attempt=%s generation=%d error=%s originalPid=%d originalPidAlive=false coldCalls=%d resumeCalls=%d trigger=serve-periodic phase=forward-stress", f.authority.ServiceID, stoppedState.PairID, stoppedState.AttemptID, stoppedState.Generation, stoppedState.Error, runtimePID, finished.OwnerCalls, finished.ResumeCalls)
	t.Logf("cross-recovery-completed cycles=%d coldCalls=%d resumeCalls=%d sameSession=true stoppedRuntimeStayedStopped=true phase=forward-stress", config.Cycles, finished.OwnerCalls, finished.ResumeCalls)
}

// Scale only the whole scenario's lifetime with its explicit amount of work.
// Every recovery still has the unchanged 25s assertion and 45s failure capture.
func recoveryCrossLifetime(cycles, idleSeconds int, phase string) time.Duration {
	budget := 180*time.Second + time.Duration(cycles)*30*time.Second
	if phase == "duplex" {
		// Both directed recovery/readback cycles occur after idle. This is an
		// outer resource lifetime, not a wider per-fault assertion.
		budget += time.Duration(idleSeconds)*time.Second + time.Duration(cycles)*30*time.Second
	}
	return budget
}

func TestWorkbenchRecoveryLongProfileOwnerBudget(t *testing.T) {
	for _, test := range []struct {
		phase string
		idle  int
		want  time.Duration
	}{
		{"forward-stress", 28800, 8 * time.Minute},
		{"duplex", 60, 14 * time.Minute},
		{"duplex", 28800, 8*time.Hour + 13*time.Minute},
		{"duplex", 43200, 12*time.Hour + 13*time.Minute},
	} {
		if got := recoveryCrossLifetime(10, test.idle, test.phase); got != test.want {
			t.Fatalf("outer owner budget phase=%s idle=%d got=%s want=%s", test.phase, test.idle, got, test.want)
		}
	}
}

func recoveryCrossConfigPath(t *testing.T) string {
	t.Helper()
	path := os.Getenv("DSHKER_TEST_CROSS_CONFIG")
	if !filepath.IsAbs(path) {
		t.Fatal("explicit absolute DSHKER_TEST_CROSS_CONFIG required")
	}
	return path
}

func recoveryCrossControl(t *testing.T, ctx context.Context, config recoveryCrossConfig, operation string) recoveryCrossStatus {
	t.Helper()
	return recoveryCrossControlPayload(t, ctx, config, operation, nil)
}

func recoveryCrossControlPayload(t *testing.T, ctx context.Context, config recoveryCrossConfig, operation string, payload any) recoveryCrossStatus {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		must(t, err)
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, "POST", config.ControlURL+operation, body)
	must(t, err)
	request.Header.Set("Authorization", "Bearer "+config.ControlSecret)
	budget := 15 * time.Second
	if strings.HasPrefix(operation, "/reverse-") {
		budget = 60 * time.Second // Disconnect + 25s connect assertion + real application readback.
	}
	client := &http.Client{Timeout: budget, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, err := client.Do(request)
	must(t, err)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("test control %s refused status=%d", operation, response.StatusCode)
	}
	var result recoveryCrossStatus
	encoded, err := io.ReadAll(io.LimitReader(response.Body, protocol.MaxControlBytes+1))
	must(t, err)
	if len(encoded) > protocol.MaxControlBytes {
		t.Fatal("test control response exceeded its exact contract bound")
	}
	must(t, json.Unmarshal(encoded, &result))
	if operation == "/reverse-idle-end" || operation == "/reverse-idle-progress" {
		// Zero traffic is an observation, never an omitted field's zero value.
		var envelope struct {
			Reverse json.RawMessage `json:"reverse"`
		}
		must(t, protocol.Decode(encoded, &envelope))
		key := "applicationIdle"
		if operation == "/reverse-idle-progress" {
			key = "applicationIdleProgress"
		}
		var reverse map[string]json.RawMessage
		must(t, json.Unmarshal(envelope.Reverse, &reverse))
		if _, present := reverse[key]; !present {
			t.Fatal("test control omitted its required exact idle observation")
		}
		var proof recoveryIdleProof
		must(t, protocol.DecodeExact(reverse[key], &proof))
		if result.Reverse == nil {
			t.Fatal("test control omitted its required reverse idle owner")
		}
		if operation == "/reverse-idle-end" {
			result.Reverse.ApplicationIdle = &proof
		} else {
			result.Reverse.ApplicationIdleProgress = &proof
		}
	}
	return result
}

// The 25s assertion has already failed. Nothing below reconnects, reconciles,
// retries, or changes either owner. One bounded window preserves the natural
// 30s transport deadline and the production timer/backoff for diagnosis only.
func recoveryCrossFailureDiagnostics(t *testing.T, ctx context.Context, config recoveryCrossConfig, core *localrpc.Peer, events <-chan peersession.State, pair string, first peersession.State) {
	t.Helper()
	observation, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	started := time.Now()
	t.Logf("cross-post-failure-observation acceptance=false maxExtra=45s firstState=%s", recoveryJSON(t, first))
	scope := recoveryDiagnosticScope{ServiceID: config.Dialer.Authority.ServiceID, PairID: pair, AttemptID: first.AttemptID, Generation: first.Generation}
	recoveryCrossCollectStack(t, observation, config, scope)
	recoveryCoreCurrentDiagnostic(t, observation, core, scope)
	last := first
	for {
		select {
		case current := <-events:
			if current.PairID == pair {
				last = current
				t.Logf("cross-post-failure-state elapsed=%s acceptance=false state=%s", time.Since(started).Round(time.Millisecond), recoveryJSON(t, current))
			}
		case <-observation.Done():
			t.Logf("cross-post-failure-observation-ended elapsed=%s acceptance=false lastState=%s reason=%v", time.Since(started).Round(time.Millisecond), recoveryJSON(t, last), observation.Err())
			return
		}
	}
}

func recoveryCrossCollectStack(t *testing.T, ctx context.Context, config recoveryCrossConfig, scope recoveryDiagnosticScope) {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	body, err := json.Marshal(scope)
	if err != nil {
		t.Log("cross-diagnostic-stack request encoding failed")
		return
	}
	request, err := http.NewRequestWithContext(deadline, "POST", config.ControlURL+"/diagnostic", bytes.NewReader(body))
	if err != nil {
		t.Log("cross-diagnostic-stack request construction failed")
		return
	}
	request.Header.Set("Authorization", "Bearer "+config.ControlSecret)
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		// Do not print request URLs/headers or an unstructured remote body.
		t.Logf("cross-diagnostic-stack unavailable context=%v", deadline.Err())
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Logf("cross-diagnostic-stack refused status=%d", response.StatusCode)
		return
	}
	var answer recoveryCrossDiagnostic
	if json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&answer) != nil || answer.Scope != scope || answer.Stack == "" || !answer.MacLastObserved.admitted(config.Dialer.Device.DeviceID, scope) {
		t.Log("cross-diagnostic-stack invalid scoped response")
		return
	}
	t.Logf("cross-diagnostic-stack service=%s pair=%s attempt=%s generation=%d macLastObserved=%s truncated=%t\n%s", scope.ServiceID, scope.PairID, scope.AttemptID, scope.Generation, recoveryJSON(t, answer.MacLastObserved), answer.Truncated, answer.Stack)
}

func recoveryCoreCurrentDiagnostic(t *testing.T, ctx context.Context, core *localrpc.Peer, scope recoveryDiagnosticScope) {
	t.Helper()
	if core == nil {
		t.Log("cross-diagnostic-core unavailable scopeKnown=false")
		return
	}
	recoveryCoreReadDiagnostic(t, ctx, core.Call, scope)
}

func recoveryCoreReadDiagnostic(t *testing.T, ctx context.Context, call recoveryCoreCall, scope recoveryDiagnosticScope) {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := call(deadline, "core.version", struct{}{})
	var version struct {
		Version            int      `json:"version"`
		MethodTableVersion int      `json:"methodTableVersion"`
		Methods            []string `json:"methods"`
	}
	if err != nil {
		t.Logf("cross-diagnostic-core-version unavailable code=%s", recoveryInitialDiagnosticCode(err))
	} else if protocol.DecodeExact(raw, &version) != nil {
		t.Log("cross-diagnostic-core-version invalid response")
	} else {
		t.Logf("cross-diagnostic-core-version version=%d methodTableVersion=%d methodCount=%d", version.Version, version.MethodTableVersion, len(version.Methods))
	}
	if !recoveryDiagnosticExact(scope) {
		t.Log("cross-diagnostic-core-entry unavailable scopeKnown=false")
		return
	}
	raw, err = call(deadline, "peer.entry", map[string]any{
		"serviceId": scope.ServiceID, "data": map[string]any{"pairId": scope.PairID, "generation": scope.Generation},
	})
	var entry struct {
		ServiceID string            `json:"serviceId"`
		State     peersession.State `json:"state"`
		URL       string            `json:"url"`
	}
	if err != nil {
		t.Logf("cross-diagnostic-core-entry unavailable pair=%s generation=%d code=%s", scope.PairID, scope.Generation, recoveryInitialDiagnosticCode(err))
	} else if protocol.DecodeExact(raw, &entry) != nil || entry.ServiceID != scope.ServiceID || entry.State.PairID != scope.PairID ||
		entry.State.AttemptID != scope.AttemptID || entry.State.Generation != scope.Generation || !recoveryInitialObservedStage(entry.State.Stage) {
		t.Log("cross-diagnostic-core-entry invalid response")
	} else {
		// The entry URL carries an authentication token and is never logged.
		code := "none"
		if entry.State.Error != "" {
			code = recoveryInitialDiagnosticCode(errors.New(entry.State.Error))
		}
		t.Logf("cross-diagnostic-core-entry urlPresent=%t pair=%s attempt=%s generation=%d stage=%s runtimeGeneration=%d code=%s", entry.URL != "", entry.State.PairID, entry.State.AttemptID, entry.State.Generation, entry.State.Stage, entry.State.RuntimeGeneration, code)
	}
}

// Rebind only this test coordinator to the explicit physical host address.
// Test accounts, devices, pair and coordinator identity remain the same records.
func recoveryRebindFixture(t *testing.T, f *realCoordinator, ip net.IP, until time.Time) {
	t.Helper()
	f.server.stop(t, false)
	data, err := os.ReadFile(f.configPath)
	must(t, err)
	var config map[string]string
	must(t, json.Unmarshal(data, &config))
	tcp, err := net.Listen("tcp", net.JoinHostPort(ip.String(), "0"))
	must(t, err)
	tcpAddress := tcp.Addr().String()
	must(t, tcp.Close())
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: ip})
	must(t, err)
	udpAddress := udp.LocalAddr().String()
	must(t, udp.Close())
	public, private, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), NotBefore: time.Now().Add(-time.Minute), NotAfter: until,
		IPAddresses: []net.IP{ip}, IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	must(t, err)
	key, err := x509.MarshalPKCS8PrivateKey(private)
	must(t, err)
	must(t, os.WriteFile(config["tlsCertPath"], pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600))
	must(t, os.WriteFile(config["tlsKeyPath"], pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0o600))
	f.endpoints = controlplane.Endpoints{HTTPSOrigin: "https://" + tcpAddress, WSSURL: "wss://" + tcpAddress + "/v1/signals", STUNAddress: udpAddress}
	config["httpsOrigin"], config["wssUrl"], config["stunAddress"] = f.endpoints.HTTPSOrigin, f.endpoints.WSSURL, udpAddress
	config["httpsListen"], config["stunListen"], config["relayPublicIP"] = tcpAddress, udpAddress, ip.String()
	encoded, err := json.Marshal(config)
	must(t, err)
	must(t, os.WriteFile(f.configPath, encoded, 0o600))
	certificate, err := x509.ParseCertificate(der)
	must(t, err)
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	client, err := controlplane.New(f.endpoints, roots)
	must(t, err)
	t.Cleanup(client.Close)
	f.client, f.root = client, der
	f.startServer(t)
	for index := range 2 {
		f.devices[index].Close()
		f.config[index].Endpoints, f.config[index].Root, f.config[index].Authority = f.endpoints, der, f.authority
		f.devices[index], err = client.WithDevice(f.config[index].Device, f.config[index].Private, f.authority)
		must(t, err)
		t.Cleanup(f.devices[index].Close)
	}
	t.Logf("cross-coordinator-bound https=%s stun=%s tlsSan=%s", tcpAddress, udpAddress, fmt.Sprint(certificate.IPAddresses))
}

func recoveryCheckCertificateLifetimes(t *testing.T, root []byte, authority controlplane.Identity, devices []controlplane.Device, until time.Time) {
	t.Helper()
	certificates := [][]byte{root, authority.Certificate}
	for _, device := range devices {
		certificates = append(certificates, device.Certificate)
	}
	for index, der := range certificates {
		certificate, err := x509.ParseCertificate(der)
		must(t, err)
		if certificate.NotBefore.After(time.Now()) || certificate.NotAfter.Before(until) {
			t.Fatalf("actual test certificate %d does not cover the requested scenario", index)
		}
		t.Logf("test-resource-lifetime certificate=%d expiresAt=%d requiredUntil=%d", index, certificate.NotAfter.Unix(), until.Unix())
	}
}

func recoveryCheckResources(t *testing.T, f *realCoordinator, until time.Time) {
	t.Helper()
	if f.userSession.ExpiresAt < until.Unix() {
		t.Fatal("actual initial user session does not cover the requested scenario; relogin is forbidden")
	}
	recoveryCheckCertificateLifetimes(t, f.root, f.authority, []controlplane.Device{f.config[0].Device, f.config[1].Device}, until)
	for index, client := range f.devices {
		ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
		credentials, err := client.TurnCredentials(ctx)
		cancel()
		must(t, err)
		expires, device, found := strings.Cut(credentials.Username, ":")
		seconds, err := strconv.ParseInt(expires, 10, 64)
		if !found || err != nil || device != f.config[index].Device.DeviceID || seconds < until.Unix() || credentials.Credential == "" || len(credentials.URLs) == 0 {
			t.Fatal("actual original TURN credentials do not cover the requested scenario")
		}
		t.Logf("test-resource-lifetime turnDevice=%s expiresAt=%d requiredUntil=%d", device, seconds, until.Unix())
	}
	t.Logf("test-resource-lifetime userSessionExpiresAt=%d requiredUntil=%d productionPoliciesUnchanged=true noRelogin=true", f.userSession.ExpiresAt, until.Unix())
}
