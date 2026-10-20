//go:build live

package integration

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
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

type recoveryCatalogView struct {
	Enabled  bool           `json:"enabled"`
	Revision string         `json:"revision"`
	Record   catalog.Record `json:"record"`
}

type recoveryCoreCall func(context.Context, string, any) (json.RawMessage, error)

func recoveryReadInitialIntent(ctx context.Context, call recoveryCoreCall, f *realCoordinator) error {
	raw, err := call(ctx, "core.catalog_inspect", struct{}{})
	if err != nil {
		return err
	}
	var current recoveryCatalogView
	if protocol.DecodeExact(raw, &current) != nil || !current.Enabled || current.Revision == "" ||
		len(current.Record.Services) != 1 || len(current.Record.Computers) != 1 || len(current.Record.ForgottenServiceIDs) != 0 {
		return errors.New("test.initial_catalog_scope_mismatch")
	}
	local, remote, pin := f.config[0].Device, f.config[1].Device, f.config[0].Pin
	localPin, remotePin := pin.Initiator, pin.Target
	if localPin.DeviceID != local.DeviceID {
		localPin, remotePin = remotePin, localPin
	}
	revision, revisionErr := hex.DecodeString(current.Revision)
	if revisionErr != nil || len(revision) != 32 || !protocol.ValidID(f.authority.ServiceID) || len(f.authority.PublicKey) != 32 || len(f.authority.Certificate) == 0 ||
		f.userSession.Token == "" || f.userSession.ExpiresAt <= time.Now().Unix() || !protocol.ValidID(f.userSession.User.UserID) ||
		localPin.UserID != f.userSession.User.UserID || remotePin.UserID != f.userSession.User.UserID || pin.Pair.State != "active" || pin.Pair.Revision == 0 ||
		!protocol.ValidID(pin.Pair.NetworkID) || !protocol.ValidID(local.DeviceID) || !protocol.ValidID(remote.DeviceID) || local.DeviceID == remote.DeviceID ||
		localPin.DeviceID != local.DeviceID || remotePin.DeviceID != remote.DeviceID || len(local.PublicKey) != 32 || len(remote.PublicKey) != 32 ||
		base64.StdEncoding.EncodeToString(localPin.PublicKey) != base64.StdEncoding.EncodeToString(local.PublicKey) || base64.StdEncoding.EncodeToString(remotePin.PublicKey) != base64.StdEncoding.EncodeToString(remote.PublicKey) {
		return errors.New("test.initial_account_scope_mismatch")
	}
	expected := catalog.Computer{
		ConnectionID: remote.DeviceID, ServiceID: f.authority.ServiceID, DisplayName: remote.Name,
		PairID: remote.DeviceID, NetworkID: pin.Pair.NetworkID, LocalDeviceID: local.DeviceID,
		RemoteDeviceID: remote.DeviceID, UserID: f.userSession.User.UserID,
		LocalPublicKey: base64.StdEncoding.EncodeToString(local.PublicKey), RemotePublicKey: base64.StdEncoding.EncodeToString(remote.PublicKey),
		PairRevision: int64(pin.Pair.Revision), PairState: "active",
	}
	if current.Record.Services[0] != integrationCatalogService(f) || current.Record.Computers[0] != expected {
		return errors.New("test.initial_catalog_scope_mismatch")
	}
	return ctx.Err()
}

// The exact attached Peer is the available core-owner identity. peer.state has
// no account/network/core fields: their scope is checked against this test-owned
// production service's catalog, not invented in the wire response. This observes only;
// it never reconciles, retries, cancels a candidate or starts a timer.
type recoveryBootstrapOwner struct {
	mu      sync.Mutex
	peer    *localrpc.Peer
	pair    string
	current peersession.State
	err     error
	changed chan struct{}
}

func (owner *recoveryBootstrapOwner) observe(state peersession.State) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if state.PairID != owner.pair || !protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) {
		owner.err = errors.New("test.initial_transport_scope_mismatch")
	} else if owner.current.Generation > state.Generation || owner.current.Generation == state.Generation && owner.current.AttemptID != state.AttemptID {
		owner.err = errors.New("test.initial_transport_owner_changed")
	} else {
		owner.current = state
	}
	close(owner.changed)
	owner.changed = make(chan struct{})
}

func recoveryCompletedTransport(state peersession.State, pair string) error {
	if state.PairID != pair || !protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) ||
		state.Stage != "connected" || state.Error != "" || state.RuntimeGeneration != 0 {
		return errors.New("test.initial_transport_not_completed")
	}
	return nil
}

func (owner *recoveryBootstrapOwner) wait(ctx context.Context, peer *localrpc.Peer) (peersession.State, error) {
	for {
		owner.mu.Lock()
		state, changed, err := owner.current, owner.changed, owner.err
		if owner.peer == nil || owner.peer != peer {
			err = errors.New("test.initial_transport_owner_changed")
		}
		owner.mu.Unlock()
		if err != nil {
			return peersession.State{}, err
		}
		if state.Stage == "connected" {
			return state, recoveryCompletedTransport(state, owner.pair)
		}
		if state.Stage != "" && state.Stage != "punching" && state.Stage != "starting-runtime" {
			return peersession.State{}, errors.New("test.initial_transport_not_completed")
		}
		select {
		case <-ctx.Done():
			return peersession.State{}, ctx.Err()
		case <-changed:
		}
	}
}

func (owner *recoveryBootstrapOwner) check(peer *localrpc.Peer, prior, opened peersession.State) error {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.err != nil {
		return owner.err
	}
	if owner.peer == nil || owner.peer != peer {
		return errors.New("test.initial_transport_owner_changed")
	}
	if owner.current == prior {
		return nil
	}
	// After dispatch the exact new business attempt may already be emitting.
	if opened.AttemptID != "" && owner.current.AttemptID == opened.AttemptID && owner.current.Generation == opened.Generation &&
		owner.current.PairID == opened.PairID && owner.current.Error == "" &&
		(owner.current.Stage == "punching" || owner.current.Stage == "starting-runtime" || owner.current.Stage == "ready") {
		return nil
	}
	return errors.New("test.initial_transport_owner_changed")
}

func recoveryInitialGeneration(completed peersession.State, pair string) (uint64, error) {
	if recoveryCompletedTransport(completed, pair) != nil || !protocol.ValidGeneration(completed.Generation+1) {
		return 0, errors.New("test.initial_generation_invalid")
	}
	return completed.Generation + 1, nil
}

func recoveryInitialBusinessOpen(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner) (peersession.Connected, error) {
	completed, err := recoveryInitialBarrier(ctx, peer, call, f, owner)
	if err != nil {
		return peersession.Connected{}, err
	}
	return recoveryOpenCompletedInitial(ctx, peer, call, f, owner, completed)
}

func recoveryInitialBarrier(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner) (peersession.State, error) {
	if peer == nil || owner == nil {
		return peersession.State{}, errors.New("test.initial_owner_required")
	}
	if err := ctx.Err(); err != nil {
		return peersession.State{}, err
	}
	completed, err := owner.wait(ctx, peer)
	if err != nil {
		return peersession.State{}, err
	}
	if err := recoveryCompletedTransport(completed, f.config[1].Device.DeviceID); err != nil {
		return peersession.State{}, err
	}
	if err := recoveryReadInitialIntent(ctx, call, f); err != nil {
		return peersession.State{}, err
	}
	if err := owner.check(peer, completed, peersession.State{}); err != nil {
		return peersession.State{}, err
	}
	return completed, ctx.Err()
}

// The actual cross driver calls this phase router. Every serve phase shares
// the same read-only barrier; core-crash alone has no Windows business intent.
func recoveryInitializeCross(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner, phase string, reverse func() error) (peersession.Connected, error) {
	switch phase {
	case "forward-stress":
		if reverse != nil {
			return peersession.Connected{}, errors.New("test.initial_reverse_not_allowed")
		}
	case "duplex", "network-fault", "program-pause", "core-crash":
		if reverse == nil {
			return peersession.Connected{}, errors.New("test.initial_reverse_required")
		}
	default:
		return peersession.Connected{}, errors.New("test.initial_phase_invalid")
	}
	completed, err := recoveryInitialBarrier(ctx, peer, call, f, owner)
	if err != nil {
		return peersession.Connected{}, err
	}
	var first peersession.Connected
	if phase != "core-crash" {
		first, err = recoveryOpenCompletedInitial(ctx, peer, call, f, owner, completed)
		if err != nil {
			return first, err
		}
	}
	if err := ctx.Err(); err != nil {
		return first, err
	}
	if reverse != nil {
		err = reverse()
	}
	return first, err
}

func recoveryOpenCompletedInitial(ctx context.Context, peer *localrpc.Peer, call recoveryCoreCall, f *realCoordinator, owner *recoveryBootstrapOwner, completed peersession.State) (peersession.Connected, error) {
	pair := f.config[1].Device.DeviceID
	generation, err := recoveryInitialGeneration(completed, pair)
	if err != nil {
		return peersession.Connected{}, err
	}
	if err := owner.check(peer, completed, peersession.State{}); err != nil {
		return peersession.Connected{}, err
	}
	raw, err := call(ctx, "peer.connect", map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{
		"pairId": pair, "generation": generation, "requestWorkbench": true,
	}})
	if err != nil {
		return peersession.Connected{}, err
	}
	if err := ctx.Err(); err != nil {
		return peersession.Connected{}, err
	}
	var first peersession.Connected
	if protocol.DecodeExact(raw, &first) != nil || first.State.PairID != pair || first.State.Generation != generation ||
		!protocol.ValidNonce(first.State.AttemptID) || first.State.Stage != "ready" || first.State.Error != "" || first.State.RuntimeGeneration != 1 || first.URL == "" {
		return first, errors.New("test.initial_business_scope_mismatch")
	}
	if err := owner.check(peer, completed, first.State); err != nil {
		return first, err
	}
	raw, err = call(ctx, "peer.entry", map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{"pairId": pair, "generation": generation}})
	if err != nil {
		return first, err
	}
	var entry struct {
		ServiceID string            `json:"serviceId"`
		State     peersession.State `json:"state"`
		URL       string            `json:"url"`
	}
	if protocol.DecodeExact(raw, &entry) != nil || entry.ServiceID != f.authority.ServiceID || entry.State != first.State || entry.URL != first.URL {
		return first, errors.New("test.initial_entry_scope_mismatch")
	}
	if err := owner.check(peer, completed, first.State); err != nil {
		return first, err
	}
	return first, ctx.Err()
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
