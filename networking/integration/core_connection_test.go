package integration

// Task 3.7's headline verification: a pair connection completes with the core as
// the only local process. There is no Electron, no dsh web and no peer helper in
// this test — only dshkerd, the production coordinator, and the fixture's second
// device running in-process so the runtime it hosts can be a stub.
import (
	"bufio"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestCoreDaemonCompletesAPeerConnection(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 120*time.Second)
	defer cancel()

	runtimeURL, stopRuntime := startStubDSH(t)
	defer stopRuntime()

	// The fixture's second device runs in this process and owns the runtime. The
	// daemon is the initiator, so it must never be asked for one of its own.
	var bindingMu sync.Mutex
	binding := runtimebridge.Binding{Generation: 1, URL: runtimeURL}
	// Presence is reported per account, exactly as the shell configures its core.
	f.devices[1].SetAccount(f.config[1].Device.UserID)
	remote, err := peersession.New(
		ctx,
		f.devices[1],
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private, CoreInstanceID: integrationCoreInstanceID(t)},
		[]controlplane.PairIdentity{},
		func(context.Context, string) (runtimebridge.Binding, error) {
			bindingMu.Lock()
			defer bindingMu.Unlock()
			return binding, nil
		},
		func(peersession.State) {},
	)
	must(t, err)
	integrationActivateManager(t, ctx, remote, f, 1)
	defer remote.Close()

	var callbackMu sync.Mutex
	var ownerRequests int
	coreStates := make(chan peersession.State, 256)
	parent, stopCore := startCoreDaemon(t, func(_ context.Context, method string, payload json.RawMessage) (any, error) {
		switch method {
		case "runtime.connect":
			callbackMu.Lock()
			ownerRequests++
			callbackMu.Unlock()
			return nil, errors.New("p2p.unexpected_runtime_owner")
		case "peer.state":
			var event struct {
				ServiceID string            `json:"serviceId"`
				State     peersession.State `json:"state"`
			}
			if json.Unmarshal(payload, &event) != nil {
				return nil, errors.New("p2p.invalid_payload")
			}
			select {
			case coreStates <- event.State:
			default:
			}
			return struct{}{}, nil
		}
		return nil, errors.New("p2p.invalid_operation")
	}, coreTrustArguments(t, f)...)
	defer stopCore()

	identity := configureCoreService(t, ctx, parent, f)
	restoreCoreDevice(t, ctx, parent, f)

	pairID := f.config[1].Device.DeviceID
	connected := callCore(t, ctx, parent, "peer.connect", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			PairID           string `json:"pairId"`
			Generation       uint64 `json:"generation"`
			RequestWorkbench bool   `json:"requestWorkbench"`
		} `json:"data"`
	}{ServiceID: identity.ServiceID, Data: struct {
		PairID           string `json:"pairId"`
		Generation       uint64 `json:"generation"`
		RequestWorkbench bool   `json:"requestWorkbench"`
	}{PairID: pairID, Generation: 1, RequestWorkbench: true}})
	var answer peersession.Connected
	must(t, json.Unmarshal(connected, &answer))
	if answer.State.Stage != "ready" || answer.State.PairID != pairID {
		t.Fatalf("core connect reported %+v", answer.State)
	}
	if path := answer.State.Path; path.Protocol != "udp" || path.LocalType == "" || path.RemoteType == "" || path.LocalType == "relay" || path.RemoteType == "relay" {
		t.Fatalf("core did not select a direct UDP path: %+v", path)
	}

	// The whole runtime path is real: the address the daemon returned proxies
	// through the negotiated data channel to the remote's stub workbench. This is
	// also the responder-side proof: answered sessions intentionally do not emit
	// renderer state for a tab/address they do not own.
	if err := runtimebridge.Probe(ctx, answer.URL); err != nil {
		t.Fatalf("probe through the core gateway: %v", err)
	}

	callbackMu.Lock()
	owners := ownerRequests
	callbackMu.Unlock()
	if owners != 0 {
		t.Fatalf("the initiator asked the shell for a runtime owner %d times", owners)
	}

	// The daemon reports connection state to the shell, which is what lets the
	// UI follow a connection it does not own.
	drainInto(coreStates, "ready")
}

// configureCoreService registers the fixture coordinator through the daemon,
// which is the same call the shell makes when a user adds a server.
func configureCoreService(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *fixture) controlplane.Identity {
	t.Helper()
	reply := callCore(t, ctx, parent, "service.configure", struct {
		Endpoints controlplane.Endpoints `json:"endpoints"`
		PinnedKey []byte                 `json:"pinnedKey"`
		Telemetry controlplane.Telemetry `json:"telemetry"`
	}{Endpoints: f.config[0].Endpoints, PinnedKey: f.authority.PublicKey, Telemetry: controlplane.Telemetry{Version: "integration", Platform: runtime.GOOS, Architecture: runtime.GOARCH}})
	var identity controlplane.Identity
	must(t, json.Unmarshal(reply, &identity))
	if identity.ServiceID != f.authority.ServiceID {
		t.Fatalf("service.configure reported %q", identity.ServiceID)
	}
	integrationConfigureCoreCatalog(t, ctx, parent, f)
	return identity
}

// restoreCoreDevice installs the fixture's device identity and pair pin, which
// is what gives the daemon something to connect with.
func restoreCoreDevice(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *fixture) {
	t.Helper()
	integrationSelectCoreAccount(t, ctx, parent, f)
	// device.restore is a scoped request: the device travels inside "data",
	// exactly as the shell sends it.
	reply := callCore(t, ctx, parent, "device.restore", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			Device        controlplane.Device         `json:"device"`
			AccountUserID string                      `json:"accountUserId"`
			PrivateKey    []byte                      `json:"privateKey"`
			Pins          []controlplane.PairIdentity `json:"pins"`
		} `json:"data"`
	}{
		ServiceID: f.authority.ServiceID,
		Data: struct {
			Device        controlplane.Device         `json:"device"`
			AccountUserID string                      `json:"accountUserId"`
			PrivateKey    []byte                      `json:"privateKey"`
			Pins          []controlplane.PairIdentity `json:"pins"`
		}{Device: f.config[0].Device, AccountUserID: f.userSession.User.UserID, PrivateKey: f.config[0].Private, Pins: []controlplane.PairIdentity{}},
	})
	var restored struct {
		DeviceID string `json:"deviceId"`
	}
	must(t, json.Unmarshal(reply, &restored))
	if restored.DeviceID != f.config[0].Device.DeviceID {
		t.Fatalf("device.restore reported %q", restored.DeviceID)
	}
}

// coreTrustArguments writes the fixture's coordinator certificate as a PEM trust
// anchor. The daemon is given it explicitly: this machine's system store does
// not hold a test CA, and the product's documented behaviour is to refuse a
// server it cannot verify rather than to weaken verification.
func coreTrustArguments(t *testing.T, f *fixture) []string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "coordinator-ca.pem")
	must(t, os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.root}), 0o600))
	return []string{"--data", t.TempDir(), "--roots", path}
}

// startCoreDaemon buildWrites, bootstraps and authenticates a real dshkerd with
// the given parent callbacks, and returns the caller plus a stop function.
func startCoreDaemon(t *testing.T, handler localrpc.Handler, args ...string) (*localrpc.Peer, func()) {
	t.Helper()
	binary := coreDaemonBinaryForTest(t)

	endpoint := coreEndpoint(t)
	secret := strings.Repeat("b", 64)
	cmd := exec.Command(binary, append([]string{"--state", desktopStateRoot(t), "--catalog", t.TempDir()}, args...)...)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	must(t, err)
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	daemon := launch(t, cmd)
	record, err := json.Marshal(localrpc.Bootstrap{Version: 1, Socket: endpoint, Secret: secret})
	must(t, err)
	_, err = stdin.Write(append(record, '\n'))
	must(t, err)
	must(t, stdin.Close())
	line, err := bufio.NewReader(stdout).ReadString('\n')
	must(t, err)
	if line != coreReadiness {
		t.Fatalf("readiness = %q", line)
	}
	conn, err := dialCore(endpoint)
	must(t, err)
	authentication, err := json.Marshal(localrpc.Authentication{Version: 1, Secret: secret})
	must(t, err)
	_, err = conn.Write(append(authentication, '\n'))
	must(t, err)
	acknowledgement := make([]byte, len(coreAuthenticated))
	_, err = io.ReadFull(conn, acknowledgement)
	must(t, err)
	if string(acknowledgement) != coreAuthenticated {
		t.Fatalf("authentication = %q", acknowledgement)
	}

	ctx, cancel := context.WithCancel(context.Background())
	parent := localrpc.New(ctx, conn, handler)
	return parent, func() {
		parent.Close()
		cancel()
		select {
		case <-daemon.done:
		case <-time.After(5 * time.Second):
			t.Error("dshkerd outlived its parent channel")
		}
	}
}

func callCore(t *testing.T, ctx context.Context, parent *localrpc.Peer, method string, payload any) json.RawMessage {
	t.Helper()
	reply, err := parent.Call(ctx, method, payload)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return reply
}

// drainInto consumes states until one reaches the wanted stage, so a slow
// callback does not leave the channel full.
func drainInto(states <-chan peersession.State, stage string) {
	for {
		select {
		case state := <-states:
			if state.Stage == stage {
				return
			}
		default:
			return
		}
	}
}

// TestCoreDaemonConnectsWhenThePeerHasNoWorkbench proves the connection is the
// daemon's own business and does not depend on a workbench existing anywhere.
//
// Connection maintenance belongs to dshkerd; a workbench is one optional thing
// carried over a link. The code used to conflate the two: a peer whose DSH would
// not start refused the runtime, and that refusal tore down a transport which had
// already been negotiated successfully. Because the shell then retried at once and
// every retry superseded the previous session, the pair never held a connection —
// and the user was told the coordinator was unreachable, which it never was.
//
// No test could see this, because every existing one hands out a stub workbench
// that always succeeds. This one refuses it the way a real machine does.
func TestCoreDaemonConnectsWhenThePeerHasNoWorkbench(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 120*time.Second)
	defer cancel()

	// The remote owns no runtime at all and says so, exactly as a Launcher whose
	// dependencies cannot be resolved does.
	f.devices[1].SetAccount(f.config[1].Device.UserID)
	var refusals int
	var refusalMu sync.Mutex
	remote, err := peersession.New(
		ctx,
		f.devices[1],
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private, CoreInstanceID: integrationCoreInstanceID(t)},
		[]controlplane.PairIdentity{},
		func(context.Context, string) (runtimebridge.Binding, error) {
			refusalMu.Lock()
			refusals++
			refusalMu.Unlock()
			return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
		},
		func(peersession.State) {},
	)
	must(t, err)
	integrationActivateManager(t, ctx, remote, f, 1)
	defer remote.Close()

	coreStates := make(chan peersession.State, 256)
	parent, stopCore := startCoreDaemon(t, func(_ context.Context, method string, payload json.RawMessage) (any, error) {
		switch method {
		case "runtime.connect":
			return nil, errors.New("p2p.unexpected_runtime_owner")
		case "peer.state":
			var event struct {
				ServiceID string            `json:"serviceId"`
				State     peersession.State `json:"state"`
			}
			if json.Unmarshal(payload, &event) != nil {
				return nil, errors.New("p2p.invalid_payload")
			}
			select {
			case coreStates <- event.State:
			default:
			}
			return struct{}{}, nil
		}
		return nil, errors.New("p2p.invalid_operation")
	}, coreTrustArguments(t, f)...)
	defer stopCore()

	identity := configureCoreService(t, ctx, parent, f)
	restoreCoreDevice(t, ctx, parent, f)

	pairID := f.config[1].Device.DeviceID
	connected := callCore(t, ctx, parent, "peer.connect", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			PairID           string `json:"pairId"`
			Generation       uint64 `json:"generation"`
			RequestWorkbench bool   `json:"requestWorkbench"`
		} `json:"data"`
	}{ServiceID: identity.ServiceID, Data: struct {
		PairID           string `json:"pairId"`
		Generation       uint64 `json:"generation"`
		RequestWorkbench bool   `json:"requestWorkbench"`
	}{PairID: pairID, Generation: 1, RequestWorkbench: true}})
	var answer peersession.Connected
	must(t, json.Unmarshal(connected, &answer))

	// The transport is connected without claiming workbench readiness:
	// the two computers are connected even though neither has a workbench to show.
	if answer.State.Stage != "connected" || answer.State.PairID != pairID || answer.State.RuntimeGeneration != 0 || answer.State.Error != "runtime.worktree_invalid" {
		t.Fatalf("connect without a workbench reported %+v", answer.State)
	}
	if path := answer.State.Path; path.Protocol != "udp" || path.LocalType == "" || path.RemoteType == "" {
		t.Fatalf("no direct path was selected: %+v", path)
	}
	// And it carries no address, because there is no workbench to address.
	if answer.URL != "" {
		t.Fatalf("a connection with no workbench still produced an address %q", answer.URL)
	}
	if code := refusalOf(t, ctx, parent, "peer.entry", map[string]any{"serviceId": identity.ServiceID, "data": map[string]any{"pairId": pairID, "generation": 1}}); code != "p2p.not_connected" {
		t.Fatalf("transport-only connection granted a workbench entry: %q", code)
	}
	refusalMu.Lock()
	asked := refusals
	refusalMu.Unlock()
	if asked == 0 {
		t.Fatal("the responder was never asked for a runtime, so the refusal was never exercised")
	}
	drainInto(coreStates, "ready")
}

// TestCoreDaemonAttachesAWorkbenchThatRecovers proves the optional workbench is
// genuinely optional in both directions: a pair connects while the peer has none,
// and a later attempt picks one up without the connection having to be rebuilt by
// hand.
//
// This is the sequence a user actually hits — DSH is broken, they fix it, they
// expect the tab to work — and the one most likely to be left behind by making a
// workbench optional at all.
func TestCoreDaemonAttachesAWorkbenchThatRecovers(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 180*time.Second)
	defer cancel()

	runtimeURL, stopRuntime := startStubDSH(t)
	defer stopRuntime()

	// The workbench is unavailable at first and becomes available later, which is
	// what repairing a broken DSH looks like from this side.
	var ownerMu sync.Mutex
	available := false
	ownerCalls := 0
	f.devices[1].SetAccount(f.config[1].Device.UserID)
	remote, err := peersession.New(
		ctx,
		f.devices[1],
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private, CoreInstanceID: integrationCoreInstanceID(t)},
		[]controlplane.PairIdentity{},
		func(context.Context, string) (runtimebridge.Binding, error) {
			ownerMu.Lock()
			defer ownerMu.Unlock()
			ownerCalls++
			if !available {
				return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
			}
			return runtimebridge.Binding{Generation: 2, URL: runtimeURL}, nil
		},
		func(peersession.State) {},
	)
	must(t, err)
	integrationActivateManager(t, ctx, remote, f, 1)
	defer remote.Close()

	parent, stopCore := startCoreDaemon(t, func(_ context.Context, method string, payload json.RawMessage) (any, error) {
		switch method {
		case "runtime.connect":
			return nil, errors.New("p2p.unexpected_runtime_owner")
		case "peer.state":
			_ = payload
			return struct{}{}, nil
		}
		return nil, errors.New("p2p.invalid_operation")
	}, coreTrustArguments(t, f)...)
	defer stopCore()

	identity := configureCoreService(t, ctx, parent, f)
	restoreCoreDevice(t, ctx, parent, f)
	pairID := f.config[1].Device.DeviceID

	connect := func(generation uint64, requestWorkbench bool) peersession.Connected {
		raw := callCore(t, ctx, parent, "peer.connect", struct {
			ServiceID string `json:"serviceId"`
			Data      struct {
				PairID           string `json:"pairId"`
				Generation       uint64 `json:"generation"`
				RequestWorkbench bool   `json:"requestWorkbench"`
			} `json:"data"`
		}{ServiceID: identity.ServiceID, Data: struct {
			PairID           string `json:"pairId"`
			Generation       uint64 `json:"generation"`
			RequestWorkbench bool   `json:"requestWorkbench"`
		}{PairID: pairID, Generation: generation, RequestWorkbench: requestWorkbench}})
		var answer peersession.Connected
		must(t, json.Unmarshal(raw, &answer))
		return answer
	}

	// Connected with no workbench: transport-only, and no address because there is
	// nothing to address.
	first := connect(1, false)
	if first.State.Stage != "connected" || first.URL != "" {
		t.Fatalf("connect without a workbench = %+v url=%q", first.State, first.URL)
	}
	ownerMu.Lock()
	if ownerCalls != 0 {
		ownerMu.Unlock()
		t.Fatalf("transport-only reconnect asked the runtime owner %d time(s)", ownerCalls)
	}
	ownerMu.Unlock()

	// The workbench comes back. The next attempt must attach it and hand out a
	// working address; nothing about the earlier attempt may prevent that.
	ownerMu.Lock()
	available = true
	ownerMu.Unlock()

	// The coordinator admits a bounded number of requests per second from one
	// source, and a single connect spends several of them. Back-to-back attempts
	// passed only on a machine slow enough to spread them out; a CI runner tripped
	// the limit and failed with p2p.rate_limited, which says nothing about the
	// behaviour under test. Waiting out the window keeps the test about workbench
	// recovery.
	waitForRequestBudget()

	second := connect(2, true)
	if second.State.Stage != "ready" {
		t.Fatalf("connect after the workbench recovered = %+v", second.State)
	}
	if second.URL == "" {
		t.Fatal("a recovered workbench produced no address, so the tab would stay dead")
	}
	ownerMu.Lock()
	if ownerCalls != 1 {
		t.Fatalf("explicit workbench request called the runtime owner %d time(s)", ownerCalls)
	}
	ownerMu.Unlock()
	// And the address genuinely serves the peer's workbench through the tunnel.
	if err := runtimebridge.Probe(ctx, second.URL); err != nil {
		t.Fatalf("probe through the recovered workbench: %v", err)
	}
}

// TestCoreDaemonSurvivesEveryWorkbenchOutcome is one run that covers the whole
// matrix of workbench outcomes a real pair goes through, because verifying these
// by installing builds on two machines costs far more than the connection itself.
//
// Each row is a defect that actually shipped. None of them was visible while every
// test handed out a workbench that always started.
func TestCoreDaemonSurvivesEveryWorkbenchOutcome(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 300*time.Second)
	defer cancel()

	runtimeURL, stopRuntime := startStubDSH(t)
	defer stopRuntime()

	// Both callbacks only read the binding of this already-running test runtime.
	// Automatic resume has no cold-start permission and must never call Open.
	var ownerMu sync.Mutex
	openCalls, resumeCalls, localOwnerCalls := 0, 0, 0
	answer := func() (runtimebridge.Binding, error) {
		return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
	}
	readOwner := func(resume bool) runtimebridge.RuntimeOwner {
		return func(_ context.Context, pair string) (runtimebridge.Binding, error) {
			ownerMu.Lock()
			defer ownerMu.Unlock()
			if pair != f.config[0].Device.DeviceID {
				return runtimebridge.Binding{}, errors.New("p2p.identity_mismatch")
			}
			if resume {
				resumeCalls++
			} else {
				openCalls++
			}
			return answer()
		}
	}
	f.devices[1].SetAccount(f.config[1].Device.UserID)
	remote, err := peersession.New(
		ctx,
		f.devices[1],
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private, CoreInstanceID: integrationCoreInstanceID(t), ResumeOwner: readOwner(true)},
		[]controlplane.PairIdentity{},
		readOwner(false),
		func(peersession.State) {},
	)
	must(t, err)
	integrationActivateManager(t, ctx, remote, f, 1)
	defer remote.Close()

	pairID := f.config[1].Device.DeviceID
	owner := &recoveryBootstrapOwner{pair: pairID, changed: make(chan struct{})}
	parent, stopCore := startCoreDaemon(t, func(_ context.Context, method string, payload json.RawMessage) (any, error) {
		switch method {
		case "runtime.connect", "runtime.resume":
			ownerMu.Lock()
			localOwnerCalls++
			ownerMu.Unlock()
			return nil, errors.New("p2p.unexpected_runtime_owner")
		case "peer.state":
			var event struct {
				ServiceID string            `json:"serviceId"`
				State     peersession.State `json:"state"`
			}
			if protocol.DecodeExact(payload, &event) != nil || event.ServiceID != f.authority.ServiceID {
				return nil, errors.New("p2p.invalid_payload")
			}
			owner.observe(event.State)
			return struct{}{}, nil
		}
		return nil, errors.New("p2p.invalid_operation")
	}, coreTrustArguments(t, f)...)
	defer stopCore()
	owner.mu.Lock()
	owner.peer = parent
	owner.mu.Unlock()

	identity := configureCoreService(t, ctx, parent, f)
	restoreCoreDevice(t, ctx, parent, f)
	// Desktop mode delegates the initial reconcile to its shell (serve owns a
	// periodic sweep). Drive that one public operation, then only observe it.
	callCore(t, ctx, parent, "peer.autoconnect_reconcile", map[string]any{"serviceId": identity.ServiceID, "data": struct{}{}})
	current, err := recoveryInitialBarrier(ctx, parent, parent.Call, f, owner)
	must(t, err)
	ownerMu.Lock()
	initialOpen, initialResume := openCalls, resumeCalls
	ownerMu.Unlock()
	if initialOpen != 0 || initialResume != 0 {
		t.Fatalf("initial transport started or resumed a workbench: open=%d resume=%d", initialOpen, initialResume)
	}

	// The caller is the child test, never its parent: an RPC refusal must fail
	// this row directly rather than calling FailNow on a captured parent T.
	connect := func(t *testing.T, generation uint64) peersession.Connected {
		t.Helper()
		raw := callCore(t, ctx, parent, "peer.connect", map[string]any{"serviceId": identity.ServiceID, "data": map[string]any{
			"pairId": pairID, "generation": generation, "requestWorkbench": true,
		}})
		var connected peersession.Connected
		must(t, protocol.DecodeExact(raw, &connected))
		if connected.State.PairID != pairID || connected.State.Generation != generation || !protocol.ValidNonce(connected.State.AttemptID) {
			t.Fatalf("explicit connect changed its exact attempt scope: %+v", connected.State)
		}
		return connected
	}

	for _, scenario := range []struct {
		name              string
		owner             func() (runtimebridge.Binding, error)
		automatic         bool
		wantAddress       bool
		wantError         string
		runtimeGeneration uint64
		// why records the shipped defect this row exists for.
		why string
	}{
		{
			name: "refused outright",
			owner: func() (runtimebridge.Binding, error) {
				return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
			},
			wantError: "runtime.worktree_invalid",
			why:       "the stream layer demanded a workbench, so this failed the connection in both directions",
		},
		{
			name: "recovered",
			owner: func() (runtimebridge.Binding, error) {
				return runtimebridge.Binding{Generation: 2, URL: runtimeURL}, nil
			},
			automatic: true, wantAddress: true, runtimeGeneration: 2,
			why: "a pair that connected without one must still be able to pick one up",
		},
		{
			name: "lost again after having one",
			owner: func() (runtimebridge.Binding, error) {
				return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
			},
			wantError: "runtime.worktree_invalid",
			why:       "the attachment stayed bound to the dead session, so its address answered every request with a failure while the UI said ready",
		},
		{
			name: "answered with an unusable address",
			owner: func() (runtimebridge.Binding, error) {
				return runtimebridge.Binding{Generation: 3, URL: "http://10.0.0.1:1/"}, nil
			},
			automatic: true, wantError: "p2p.runtime_invalid",
			why: "a non-loopback answer must not become a tunnel, and must not kill the link either",
		},
		{
			name: "recovered a second time",
			owner: func() (runtimebridge.Binding, error) {
				return runtimebridge.Binding{Generation: 4, URL: runtimeURL}, nil
			},
			automatic: true, wantAddress: true, runtimeGeneration: 4,
			why: "recovery must not be a one-time affair",
		},
	} {
		if !t.Run(scenario.name, func(t *testing.T) {
			ownerMu.Lock()
			answer = scenario.owner
			beforeOpen, beforeResume := openCalls, resumeCalls
			ownerMu.Unlock()

			wantStage := "connected"
			if scenario.wantAddress {
				wantStage = "ready"
			}
			var connected peersession.Connected
			if scenario.automatic {
				// Intent remains set after refusal. Let the actual core engine own
				// recovery instead of guessing a generation or retrying stale/busy.
				attemptCtx, stop := context.WithTimeout(ctx, 25*time.Second)
				defer stop()
				state, err := coreWaitWorkbenchOutcome(attemptCtx, parent, parent.Call, f, owner, current.Generation, wantStage, scenario.wantError, scenario.runtimeGeneration)
				must(t, err)
				connected.State = state
				if scenario.wantAddress {
					raw := callCore(t, ctx, parent, "peer.entry", map[string]any{"serviceId": identity.ServiceID, "data": map[string]any{"pairId": pairID, "generation": state.Generation}})
					var entry struct {
						ServiceID string            `json:"serviceId"`
						State     peersession.State `json:"state"`
						URL       string            `json:"url"`
					}
					must(t, protocol.DecodeExact(raw, &entry))
					if entry.ServiceID != identity.ServiceID || entry.State != state {
						t.Fatalf("automatic recovery changed its exact entry owner: %+v", entry)
					}
					connected.URL = entry.URL
				}
			} else {
				// Only completed transport-only/ready owners are quiescent. The
				// same D24 barrier and exact +1 admission guard explicit opens.
				waitForRequestBudget()
				must(t, owner.check(parent, current, peersession.State{}))
				var generation uint64
				if current.Stage == "connected" {
					generation, err = recoveryInitialGeneration(current, pairID)
				} else {
					generation, err = coreReadySuccessorGeneration(current, pairID)
				}
				must(t, err)
				connected = connect(t, generation)
			}
			ownerMu.Lock()
			opened, resumed, local := openCalls-beforeOpen, resumeCalls-beforeResume, localOwnerCalls
			ownerMu.Unlock()
			if local != 0 || scenario.automatic && (opened != 0 || resumed == 0) || !scenario.automatic && opened != 1 {
				t.Fatalf("runtime authority changed: automatic=%t open=%d resume=%d local=%d", scenario.automatic, opened, resumed, local)
			}
			// Maintenance belongs to the daemon; a workbench remains optional cargo.
			if connected.State.Stage != wantStage || connected.State.PairID != pairID || connected.State.Error != scenario.wantError || connected.State.RuntimeGeneration != scenario.runtimeGeneration {
				t.Fatalf("%s: connection not established (%s): %+v", scenario.name, scenario.why, connected.State)
			}
			if path := connected.State.Path; path.Protocol != "udp" || path.LocalType == "" || path.RemoteType == "" {
				t.Fatalf("%s: no direct path: %+v", scenario.name, path)
			}
			current = connected.State
			t.Logf("workbench-outcome automatic=%t open=%d resume=%d state=%+v", scenario.automatic, opened, resumed, current)
			if scenario.wantAddress {
				if connected.URL == "" {
					t.Fatalf("%s: no address, so the tab stays dead (%s)", scenario.name, scenario.why)
				}
				if err := runtimebridge.Probe(ctx, connected.URL); err != nil {
					t.Fatalf("%s: the address does not serve the peer (%s): %v", scenario.name, scenario.why, err)
				}
				return
			}
			if connected.URL != "" {
				t.Fatalf("%s: handed out an address with no workbench behind it (%s): %q", scenario.name, scenario.why, connected.URL)
			}
			if err := coreReadRefusedHistoricalEntry(ctx, parent.Call, identity.ServiceID, pairID, connected); err != nil {
				t.Fatalf("%s: transport-only historical entry readback: %v", scenario.name, err)
			}
		}) {
			// A failed row has no authoritative completed owner for the next one.
			return
		}
	}
}

// waitForRequestBudget spaces out consecutive connect attempts.
//
// The coordinator allows a bounded number of requests per second from one source
// and a single connect spends several. Tests that dispatched attempts back to back
// passed locally and failed on a faster runner with p2p.rate_limited — a limit
// working as designed, reported as a test failure about something else entirely.
func waitForRequestBudget() {
	time.Sleep(1100 * time.Millisecond)
}
