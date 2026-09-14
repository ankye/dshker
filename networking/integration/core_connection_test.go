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
	remoteStates := make(chan peersession.State, 256)
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
		func(state peersession.State) {
			select {
			case remoteStates <- state:
			default:
			}
		},
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

	// The remote device must have observed the same connection.
	waitForStage(t, remoteStates, "ready", 30*time.Second)

	// The whole runtime path is real: the address the daemon returned proxies
	// through the negotiated data channel to the remote's stub workbench.
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
	cmd := exec.Command(binary, args...)
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

func waitForStage(t *testing.T, states <-chan peersession.State, stage string, budget time.Duration) {
	t.Helper()
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	for {
		select {
		case state := <-states:
			if state.Stage == stage {
				return
			}
		case <-deadline.C:
			t.Fatalf("no %s state within %s", stage, budget)
		}
	}
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
