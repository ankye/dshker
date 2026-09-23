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
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private},
		[]controlplane.PairIdentity{f.config[1].Pin},
		func(context.Context, string) (runtimebridge.Binding, error) {
			bindingMu.Lock()
			defer bindingMu.Unlock()
			return binding, nil
		},
		func(peersession.State) {},
	)
	must(t, err)
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

	pairID := f.config[0].Pin.Pair.PairID
	connected := callCore(t, ctx, parent, "peer.connect", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			PairID     string `json:"pairId"`
			Generation uint64 `json:"generation"`
		} `json:"data"`
	}{ServiceID: identity.ServiceID, Data: struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}{PairID: pairID, Generation: 1}})
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
	return identity
}

// restoreCoreDevice installs the fixture's device identity and pair pin, which
// is what gives the daemon something to connect with.
func restoreCoreDevice(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *fixture) {
	t.Helper()
	// device.restore is a scoped request: the device travels inside "data",
	// exactly as the shell sends it.
	reply := callCore(t, ctx, parent, "device.restore", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			Device     controlplane.Device         `json:"device"`
			PrivateKey []byte                      `json:"privateKey"`
			Pins       []controlplane.PairIdentity `json:"pins"`
		} `json:"data"`
	}{
		ServiceID: f.authority.ServiceID,
		Data: struct {
			Device     controlplane.Device         `json:"device"`
			PrivateKey []byte                      `json:"privateKey"`
			Pins       []controlplane.PairIdentity `json:"pins"`
		}{Device: f.config[0].Device, PrivateKey: f.config[0].Private, Pins: []controlplane.PairIdentity{f.config[0].Pin}},
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
	binary := filepath.Join(t.TempDir(), "dshkerd")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	build.Stderr = os.Stderr
	must(t, build.Run())

	endpoint := coreEndpoint(t)
	secret := strings.Repeat("b", 64)
	cmd := exec.Command(binary, append([]string{"--state", desktopStateRoot(t)}, args...)...)
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
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private},
		[]controlplane.PairIdentity{f.config[1].Pin},
		func(context.Context, string) (runtimebridge.Binding, error) {
			refusalMu.Lock()
			refusals++
			refusalMu.Unlock()
			return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
		},
		func(peersession.State) {},
	)
	must(t, err)
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

	pairID := f.config[0].Pin.Pair.PairID
	connected := callCore(t, ctx, parent, "peer.connect", struct {
		ServiceID string `json:"serviceId"`
		Data      struct {
			PairID     string `json:"pairId"`
			Generation uint64 `json:"generation"`
		} `json:"data"`
	}{ServiceID: identity.ServiceID, Data: struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}{PairID: pairID, Generation: 1}})
	var answer peersession.Connected
	must(t, json.Unmarshal(connected, &answer))

	// The connection is established and reported ready. This is the whole point:
	// the two computers are connected even though neither has a workbench to show.
	if answer.State.Stage != "ready" || answer.State.PairID != pairID {
		t.Fatalf("connect without a workbench reported %+v", answer.State)
	}
	if path := answer.State.Path; path.Protocol != "udp" || path.LocalType == "" || path.RemoteType == "" {
		t.Fatalf("no direct path was selected: %+v", path)
	}
	// And it carries no address, because there is no workbench to address.
	if answer.URL != "" {
		t.Fatalf("a connection with no workbench still produced an address %q", answer.URL)
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
	f.devices[1].SetAccount(f.config[1].Device.UserID)
	remote, err := peersession.New(
		ctx,
		f.devices[1],
		peersession.Config{Endpoints: f.config[1].Endpoints, Authority: f.config[1].Authority, Device: f.config[1].Device, PrivateKey: f.config[1].Private},
		[]controlplane.PairIdentity{f.config[1].Pin},
		func(context.Context, string) (runtimebridge.Binding, error) {
			ownerMu.Lock()
			defer ownerMu.Unlock()
			if !available {
				return runtimebridge.Binding{}, errors.New("runtime.worktree_invalid")
			}
			return runtimebridge.Binding{Generation: 2, URL: runtimeURL}, nil
		},
		func(peersession.State) {},
	)
	must(t, err)
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
	pairID := f.config[0].Pin.Pair.PairID

	connect := func(generation uint64) peersession.Connected {
		raw := callCore(t, ctx, parent, "peer.connect", struct {
			ServiceID string `json:"serviceId"`
			Data      struct {
				PairID     string `json:"pairId"`
				Generation uint64 `json:"generation"`
			} `json:"data"`
		}{ServiceID: identity.ServiceID, Data: struct {
			PairID     string `json:"pairId"`
			Generation uint64 `json:"generation"`
		}{PairID: pairID, Generation: generation}})
		var answer peersession.Connected
		must(t, json.Unmarshal(raw, &answer))
		return answer
	}

	// Connected with no workbench: ready, and no address because there is nothing
	// to address.
	first := connect(1)
	if first.State.Stage != "ready" || first.URL != "" {
		t.Fatalf("connect without a workbench = %+v url=%q", first.State, first.URL)
	}

	// The workbench comes back. The next attempt must attach it and hand out a
	// working address; nothing about the earlier attempt may prevent that.
	ownerMu.Lock()
	available = true
	ownerMu.Unlock()

	second := connect(2)
	if second.State.Stage != "ready" {
		t.Fatalf("connect after the workbench recovered = %+v", second.State)
	}
	if second.URL == "" {
		t.Fatal("a recovered workbench produced no address, so the tab would stay dead")
	}
	// And the address genuinely serves the peer's workbench through the tunnel.
	if err := runtimebridge.Probe(ctx, second.URL); err != nil {
		t.Fatalf("probe through the recovered workbench: %v", err)
	}
}
