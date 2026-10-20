//go:build live

package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// The same test runs an explicitly selected before/candidate production binary.
// It never attaches to the installed core, its state root, or its active DSH.
func recoveryCore(t *testing.T, f *realCoordinator, events chan peersession.State, localOwnerCalls *atomic.Int64) *localrpc.Peer {
	t.Helper()
	return recoveryCoreWithOwner(t, f, events, func(context.Context, string, json.RawMessage) (any, error) {
		localOwnerCalls.Add(1)
		return nil, errors.New("p2p.unexpected_runtime_owner")
	})
}

func recoveryCoreWithOwner(t *testing.T, f *realCoordinator, events chan peersession.State, owner localrpc.Handler) *localrpc.Peer {
	return recoveryCoreOwned(t, f, events, owner).Peer
}

type recoveryOwnedCore struct {
	Peer      *localrpc.Peer
	Process   *process
	Binary    string
	StateRoot string
	Owner     *recoveryOwnerTeardown
	Initial   *recoveryBootstrapOwner
}

func recoveryCoreOwned(t *testing.T, f *realCoordinator, events chan peersession.State, owner localrpc.Handler) recoveryOwnedCore {
	t.Helper()
	recoveryRequireIsolatedCore(t)
	binary := os.Getenv("DSHKER_TEST_CORE_BINARY")
	if !filepath.IsAbs(binary) {
		t.Fatal("explicit absolute DSHKER_TEST_CORE_BINARY required")
	}
	info, err := os.Stat(binary)
	must(t, err)
	if !info.Mode().IsRegular() {
		t.Fatal("DSHKER_TEST_CORE_BINARY is not a regular file")
	}
	stateRoot := stateDirectoryForCLI(t)
	rootsPath := filepath.Join(t.TempDir(), "coordinator-ca.pem")
	writeRootsPEM(t, rootsPath, f.root)
	args := []string{"serve", "--state", stateRoot, "--catalog", t.TempDir(), "--roots", rootsPath}
	// The actual Windows DPAPI provider is scoped by this explicit data root.
	args = append(args, "--data", t.TempDir())
	daemon := recoveryStartServe(t, binary, args)
	// The independent owner must be covered before configuration, runtime.start
	// or the initial remote workbench can fail. A killed core cannot run defers.
	authority := recoveryRegisterOwnerTeardown(t, daemon.cmd)
	initial := &recoveryBootstrapOwner{pair: f.config[1].Device.DeviceID, changed: make(chan struct{})}
	parent := recoveryAttachObservedCore(t, f, events, owner, stateRoot, func(*localrpc.Peer) { authority.finish(t) }, initial)
	initial.mu.Lock()
	initial.peer = parent
	initial.mu.Unlock()
	configureCoreService(t, f.ctx, parent, f)
	integrationSelectCoreAccount(t, f.ctx, parent, f)
	// Initial enrollment only. A crash restart must not replay this request.
	callCore(t, f.ctx, parent, "device.restore", map[string]any{
		"serviceId": f.authority.ServiceID,
		"data":      map[string]any{"device": f.config[0].Device, "accountUserId": f.userSession.User.UserID, "privateKey": f.config[0].Private, "pins": []any{}},
	})
	t.Log("production-recovery-owner mode=serve periodicSweep=5s observer=authenticated-desktop-attach")
	return recoveryOwnedCore{Peer: parent, Process: daemon, Binary: binary, StateRoot: stateRoot, Owner: authority, Initial: initial}
}

// Attach is observational: no configure, restore, peer open or runtime start.
func recoveryAttachCore(t *testing.T, f *realCoordinator, events chan peersession.State, owner localrpc.Handler, stateRoot string, beforeClose func(*localrpc.Peer)) *localrpc.Peer {
	return recoveryAttachObservedCore(t, f, events, owner, stateRoot, beforeClose, nil)
}

func recoveryAttachObservedCore(t *testing.T, f *realCoordinator, events chan peersession.State, owner localrpc.Handler, stateRoot string, beforeClose func(*localrpc.Peer), initial *recoveryBootstrapOwner) *localrpc.Peer {
	t.Helper()
	record, err := localrpc.ReadEndpointRecord(filepath.Join(stateRoot, localrpc.EndpointFileName))
	must(t, err)
	connection, err := localrpc.Connect(f.ctx, record.Socket, record.Secret)
	must(t, err)
	// The RPC owner must outlive the scenario deadline so LIFO cleanup can stop
	// a core-owned DSH before closing this channel and terminating the core.
	parent := localrpc.New(context.Background(), connection, func(ctx context.Context, method string, payload json.RawMessage) (any, error) {
		switch method {
		case "runtime.connect", "runtime.resume":
			return owner(ctx, method, payload)
		case "peer.state":
			var event struct {
				ServiceID string            `json:"serviceId"`
				State     peersession.State `json:"state"`
			}
			if protocol.DecodeExact(payload, &event) != nil || event.ServiceID != f.authority.ServiceID {
				return nil, errors.New("p2p.invalid_payload")
			}
			if initial != nil {
				initial.observe(event.State)
			}
			events <- event.State
			return struct{}{}, nil
		case "directory.state":
			return struct{}{}, nil
		}
		return nil, errors.New("p2p.invalid_operation")
	})
	// Cleanup is LIFO: explicit runtime/owner teardown, detach RPC, then launch's
	// sole exact-owned core cleanup. This does not claim normal-core shutdown.
	t.Cleanup(func() {
		if beforeClose != nil {
			beforeClose(parent)
		}
		parent.Close()
	})
	var attached struct {
		Attached bool `json:"attached"`
	}
	must(t, json.Unmarshal(callCore(t, f.ctx, parent, "core.desktop_attach", struct{}{}), &attached))
	if !attached.Attached {
		t.Fatal("core did not attach the authenticated state observer")
	}
	return parent
}

func recoveryStartServe(t *testing.T, binary string, args []string) *process {
	t.Helper()
	command := exec.Command(binary, args...)
	for _, value := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(value, "=", 2)[0])
		if name != "DSH_HOME" && !strings.HasPrefix(name, "PION_LOG_") && !strings.HasPrefix(name, "PIONS_LOG_") && name != "DSHKER_TURN_DEBUG" {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "PION_LOG_WARN=all", "PION_LOG_INFO=ice,pc")
	t.Log("test-diagnostic-profile name=state-and-cause pionDefault=warn pionInfo=ice,pc inheritedPacketTrace=false")
	// A core-owned real DSH inherits only this test's explicit home.
	command.Env = append(command.Env, "DSH_HOME="+t.TempDir())
	return recoveryLaunchServe(t, command, nil)
}

func recoveryLaunchServe(t *testing.T, command *exec.Cmd, teardown func()) *process {
	t.Helper()
	stdout, err := command.StdoutPipe()
	must(t, err)
	if command.Stderr == nil {
		command.Stderr = os.Stderr
	}
	// launch registers exact-child cleanup before readiness can fail.
	daemon := launch(t, command)
	if teardown != nil {
		t.Cleanup(teardown)
	}
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var event struct {
				Version int    `json:"version"`
				Serving bool   `json:"serving"`
				Socket  string `json:"socket"`
			}
			if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Serving {
				ready <- event.Version == 1 && event.Socket != ""
				return
			}
		}
	}()
	select {
	case valid := <-ready:
		if !valid {
			t.Fatal("production serve announced invalid readiness")
		}
	case <-daemon.done:
		t.Fatal("production serve exited before readiness")
	case <-time.After(30 * time.Second):
		t.Fatal("production serve did not announce readiness within 30 seconds")
	}
	return daemon
}

func recoveryRequireIsolatedCore(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Fatal("this autonomous live core profile requires Windows DPAPI with an explicit temporary data root; shared macOS Keychain is forbidden")
	}
}

// Initial configuration owns the only Enable. Restore publishes fresh scoped
// computers; this readback neither grants unverified pins nor rewrites that record.
func recoveryEnableIntent(t *testing.T, f *realCoordinator, parent *localrpc.Peer) {
	t.Helper()
	must(t, recoveryReadInitialIntent(f.ctx, parent.Call, f))
}

func recoveryCall(t *testing.T, ctx context.Context, core *localrpc.Peer, f *realCoordinator, method string, data any) json.RawMessage {
	t.Helper()
	return callCore(t, ctx, core, method, map[string]any{"serviceId": f.authority.ServiceID, "data": data})
}

func recoveryState(t *testing.T, ctx context.Context, events <-chan peersession.State, pair string, after uint64, stage string) peersession.State {
	t.Helper()
	return recoveryStateWithDiagnostics(t, ctx, events, pair, after, stage, nil)
}

func recoveryStateWithDiagnostics(t *testing.T, ctx context.Context, events <-chan peersession.State, pair string, after uint64, stage string, onTimeout func(peersession.State)) peersession.State {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	var last peersession.State
	for {
		select {
		case last = <-events:
			if last.PairID == pair && last.Generation > after && last.Stage == stage {
				t.Logf("recovery-state %s", recoveryJSON(t, last))
				return last
			}
		case <-deadline.Done():
			// Register the original threshold failure before collecting anything.
			// Diagnostic observation can never turn a late recovery into a pass.
			t.Errorf("automatic recovery never reached %s after generation %d within 25s; last=%s", stage, after, recoveryJSON(t, last))
			if onTimeout != nil {
				onTimeout(last)
			}
			t.FailNow()
		}
	}
}

func recoveryEntry(t *testing.T, ctx context.Context, core *localrpc.Peer, f *realCoordinator, state peersession.State) string {
	t.Helper()
	var answer struct {
		ServiceID string            `json:"serviceId"`
		State     peersession.State `json:"state"`
		URL       string            `json:"url"`
	}
	raw := recoveryCall(t, ctx, core, f, "peer.entry", map[string]any{"pairId": state.PairID, "generation": state.Generation})
	must(t, protocol.DecodeExact(raw, &answer))
	if answer.ServiceID != f.authority.ServiceID || answer.State != state || answer.State.Stage != "ready" || answer.URL == "" {
		t.Fatal("authoritative entry did not retain exact current service/pair/attempt/generation")
	}
	return answer.URL
}

func recoveryJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	must(t, err)
	return string(encoded)
}
