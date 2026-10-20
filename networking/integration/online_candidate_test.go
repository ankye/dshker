//go:build live

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/rootregistry"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// Explicit external gate. Running the local coordinator suite does not run this
// test; no missing endpoint, pin, stdin password or Harness input is substituted.
// This proves system TLS + online control + two production Host compositions and
// two real DSH children on this computer, not packaged/native/two-machine UI.
func TestOnlineCandidateTLSWSSScopedLifecycleAndHostsRealDSH(t *testing.T) {
	inputs, err := readOnlineCandidateInputs(os.Getenv)
	onlineCandidateMust(t, "required-explicit-inputs", err)
	entry, err := os.Stat(filepath.Join(inputs.harnessRoot, "apps", "cli", "lib", "bin.js"))
	onlineCandidateMust(t, "explicit-real-harness", err)
	if !entry.Mode().IsRegular() {
		t.Fatal("explicit Harness CLI entry is not a regular file")
	}
	password, err := readOnlineCandidatePassword(os.Stdin)
	onlineCandidateMust(t, "stdin-password", err)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	onlineCandidateTLS(t, ctx, inputs)
	f := newOnlineCandidateFixture(t, ctx, inputs, password)
	password = ""
	control, stopControl := context.WithTimeout(ctx, 25*time.Second)
	onlineCandidateLifecycle(t, control, f)
	stopControl()
	// The real runtimes are only needed by the Host phase. Their required startup
	// is not a sleep, source-limiter bypass or a repeated business operation.
	var runtimes [2]string
	for index := range runtimes {
		onlineCandidateRegisterRoots(t, inputs.harnessRoot)
		runtimes[index], _ = startRealDSH(t)
	}
	var peers [2]hostColdPeer
	workers := newOnlineCandidateWorkers(f.ctx)
	f.hostWorkers = workers
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := workers.stop(cleanup); err != nil {
			t.Errorf("online Host worker teardown did not join; remote scope cleanup is forbidden: %s", hostColdError(err))
		}
	}()
	for index := range peers {
		peers[index] = onlineCandidateSeedAndRecreate(t, f, workers, index, runtimes[index])
	}
	onlineCandidateHostRound(t, f, workers, peers, runtimes)
}

// The test owns every Restore, initial Reconcile and explicit traffic job. Host
// Close cancels the production engine's independent context before these jobs
// are joined. Remote scope deletion is forbidden until joined is closed.
type onlineCandidateWorkers struct {
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	closing   bool
	resources []func()
	wait      sync.WaitGroup
	once      sync.Once
	joined    chan struct{}
}

func newOnlineCandidateWorkers(parent context.Context) *onlineCandidateWorkers {
	ctx, cancel := context.WithCancel(parent)
	return &onlineCandidateWorkers{ctx: ctx, cancel: cancel, joined: make(chan struct{})}
}

func (owner *onlineCandidateWorkers) addResource(closeResource func()) bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.closing || owner.ctx.Err() != nil {
		return false
	}
	owner.resources = append(owner.resources, closeResource)
	return true
}

func (owner *onlineCandidateWorkers) start(ctx context.Context, job func(context.Context)) bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.closing || owner.ctx.Err() != nil || ctx.Err() != nil {
		return false
	}
	owner.wait.Add(1)
	go func() {
		defer owner.wait.Done()
		operation, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(owner.ctx, cancel)
		defer stop()
		defer cancel()
		job(operation)
	}()
	return true
}

func (owner *onlineCandidateWorkers) publish(ctx context.Context, send func()) bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.closing || owner.ctx.Err() != nil || ctx.Err() != nil {
		return false
	}
	// All callers publish to a dedicated channel with capacity for every job.
	send()
	return true
}

func (owner *onlineCandidateWorkers) stop(ctx context.Context) error {
	owner.once.Do(func() {
		owner.mu.Lock()
		owner.closing = true
		resources := append([]func(){}, owner.resources...)
		owner.mu.Unlock()
		owner.cancel()
		go func() {
			for _, closeResource := range resources {
				closeResource()
			}
			owner.wait.Wait()
			close(owner.joined)
		}()
	})
	select {
	case <-owner.joined:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (owner *onlineCandidateWorkers) isJoined() bool {
	select {
	case <-owner.joined:
		return true
	default:
		return false
	}
}

func onlineCandidateRegisterRoots(t *testing.T, harnessRoot string) {
	t.Helper()
	base := t.TempDir()
	registry := rootregistry.Registry{Format: rootregistry.Format, Version: rootregistry.Version, Roots: []rootregistry.Root{
		{RootID: "online_harness", Kind: "harness", CanonicalPath: harnessRoot},
		{RootID: "online_plugins", Kind: "plugins", CanonicalPath: filepath.Join(base, "plugins")},
		{RootID: "online_presets", Kind: "presets", CanonicalPath: filepath.Join(base, "presets")},
		{RootID: "online_settings", Kind: "settings", CanonicalPath: filepath.Join(base, "settings")},
	}, Workspaces: []rootregistry.Workspace{}}
	for _, root := range registry.Roots[1:] {
		onlineCandidateMust(t, "isolated-registered-root-create", os.Mkdir(root.CanonicalPath, 0700))
	}
	store, err := rootregistry.Open(filepath.Join(base, rootregistry.RegistryFileName), filepath.Join(base, "native-dsh-home"))
	onlineCandidateMust(t, "isolated-root-registry-open", err)
	onlineCandidateMust(t, "isolated-root-registry-save", store.Save(registry))
	readback, err := store.Load()
	onlineCandidateMust(t, "isolated-root-registry-readback", err)
	if !reflect.DeepEqual(readback, registry) {
		t.Fatal("isolated registered roots changed the explicit Harness or temporary data owners")
	}
}

// The local secret/callback stores below are test-only. SetRoots is deliberately
// absent: both Host lifetimes retain production's system public TLS trust.
func onlineCandidateSeedAndRecreate(t *testing.T, f *onlineCandidateFixture, workers *onlineCandidateWorkers, index int, runtimeURL string) hostColdPeer {
	t.Helper()
	store := &certificateSecrets{values: map[string][]byte{}}
	catalogStore := integrationOpenCatalog(t, f.fixture)
	seed := helper.New(f.ctx)
	seed.SetDeviceKeys(store)
	seed.SetCatalog(catalogStore)
	callbacks := &certificateCallbacks{}
	seed.BindMain(callbacks)
	t.Cleanup(seed.Close)
	server := core.Serve{Store: store, Peer: seed, Catalog: catalogStore}
	data, err := json.Marshal(map[string]any{"endpoints": f.endpoints, "pinnedKey": f.authority.PublicKey, "telemetry": controlplane.Telemetry{Version: "online-candidate-test"}})
	onlineCandidateMust(t, "initial-configure-encode", err)
	_, err = server.Handle(f.ctx, "service.configure", data)
	onlineCandidateMust(t, "initial-online-service-configure", err)
	integrationSelectDirectAccount(t, f.ctx, server, f.authority.ServiceID, f.userSession)
	device := f.config[index].Device
	onlineCandidateMust(t, "initial-owned-device-persistence", seed.SaveCredential(f.authority.ServiceID, device, f.config[index].Private))
	session, err := store.Get("peer-user-session:" + f.authority.ServiceID)
	onlineCandidateMust(t, "initial-session-persistence", err)
	if !bytes.Equal(session, integrationSessionRecord(t, f.userSession)) {
		t.Fatal("initial online persistence changed this run's issued session")
	}
	seed.Close()
	callbacks.mu.Lock()
	seedRuntimeCalls := callbacks.runtimeCalls
	callbacks.mu.Unlock()
	if seedRuntimeCalls != 0 {
		t.Fatal("credential seed activated a runtime")
	}
	owner := &hostColdOwner{serviceID: f.authority.ServiceID, pairID: f.config[1-index].Device.DeviceID, binding: runtimebridge.Binding{Generation: uint64(index + 1), URL: runtimeURL}, receipts: make(chan peersession.State, 128)}
	host := helper.New(f.ctx)
	if !workers.addResource(host.Close) {
		host.Close()
		t.Fatal("online Host could not be registered under its test worker owner")
	}
	host.SetDeviceKeys(store)
	host.SetCatalog(catalogStore)
	host.BindMain(owner)
	return hostColdPeer{host: host, server: core.Serve{Store: store, Peer: host, Catalog: catalogStore}, store: store, owner: owner, session: session, original: device}
}

func onlineCandidateHostRound(t *testing.T, f *onlineCandidateFixture, workers *onlineCandidateWorkers, peers [2]hostColdPeer, runtimes [2]string) {
	t.Helper()
	started := time.Now()
	ctx, cancel := context.WithDeadline(f.ctx, started.Add(25*time.Second))
	defer cancel()
	start, restored := make(chan struct{}), make(chan int, 2)
	for index := range peers {
		peers[index].owner.observe = func(state peersession.State) {
			t.Logf("online-host-state local=%s remote=%s service=%s user=%s network=%s attempt=%s generation=%d stage=%s runtimeGeneration=%d code=%s elapsedMs=%d", peers[index].original.DeviceID, state.PairID, f.authority.ServiceID, f.userSession.User.UserID, f.network.NetworkID, state.AttemptID, state.Generation, state.Stage, state.RuntimeGeneration, state.Error, time.Since(started).Milliseconds())
		}
		if !workers.start(ctx, func(operation context.Context) {
			select {
			case <-start:
			case <-operation.Done():
				return
			}
			count := peers[index].host.RestoreOwnCredentials(operation)
			workers.publish(operation, func() { restored <- count })
		}) {
			t.Fatal("online initial Restore could not start within its original deadline")
		}
	}
	close(start)
	for range peers {
		select {
		case count := <-restored:
			onlineCandidateMust(t, "initial-host-restore-budget", hostColdBudget(ctx))
			if count != 0 && count != 1 {
				t.Fatal("online Host restored more than this run's sole service")
			}
		case <-ctx.Done():
			t.Fatal("online Host initial restore exceeded original 25s shared deadline")
		}
	}
	reconciled := make(chan int, 2)
	for index := range peers {
		if !workers.start(ctx, func(operation context.Context) {
			// Exactly one production scan per Host. Its Connect uses engine.ctx,
			// so only Host.Close can cancel/join it after the business deadline.
			peers[index].host.AutoConnectEngine().Reconcile(operation)
			workers.publish(operation, func() { reconciled <- index })
		}) {
			t.Fatal("online initial Reconcile could not start within its original deadline")
		}
	}
	for range peers {
		select {
		case <-reconciled:
			onlineCandidateMust(t, "initial-reconcile-budget", hostColdBudget(ctx))
		case <-ctx.Done():
			t.Fatal("online initial Reconcile exceeded original 25s shared deadline")
		}
	}
	transport, err := hostColdObserveTransport(ctx, [2]*hostColdOwner{peers[0].owner, peers[1].owner})
	onlineCandidateMust(t, "both-online-host-transports", err)
	var generations [2]uint64
	for index := range peers {
		hostColdAssertCredential(t, f.fixture, peers[index], index)
		hostColdAssertCatalog(t, ctx, f.fixture, peers[index], index)
		peers[index].owner.mu.Lock()
		calls, resumes := peers[index].owner.connects, peers[index].owner.resumes
		peers[index].owner.mu.Unlock()
		if calls != 0 || resumes != 0 {
			t.Fatal("online background bootstrap activated a workbench")
		}
		generations[index] = transport[index].Generation + 1
	}
	connected := onlineCandidateHostTraffic(t, ctx, f, workers, peers, generations)
	for index, active := range connected {
		onlineCandidateMust(t, "online-ready-budget", hostColdBudget(ctx))
		if active.State.Stage != "ready" || !protocol.ValidNonce(active.State.AttemptID) || active.State.Generation != generations[index] || active.State.PairID != f.config[1-index].Device.DeviceID || active.State.RuntimeGeneration != peers[1-index].owner.binding.Generation || active.URL == "" || active.URL == runtimes[1-index] {
			t.Fatal("online ready did not identify the exact committed workbench and gateway")
		}
		value, err := hostColdCall(ctx, peers[index].server, "peer.entry", json.RawMessage(envelope(t, f.authority.ServiceID, map[string]any{"pairId": active.State.PairID, "generation": active.State.Generation})))
		onlineCandidateMust(t, "current-online-host-entry", err)
		entry := hostColdDecode[struct {
			ServiceID string            `json:"serviceId"`
			State     peersession.State `json:"state"`
			URL       string            `json:"url"`
		}](t, value)
		if entry.ServiceID != f.authority.ServiceID || entry.State != active.State || entry.URL != active.URL {
			t.Fatal("online current entry changed exact service/attempt/generation ownership")
		}
		// Production Probe requires authenticated real HTTP, cookie issuance and
		// an actual /api/remote.mux WebSocket upgrade through this P2P gateway.
		onlineCandidateMust(t, "online-real-dsh-http-and-websocket", runtimebridge.Probe(ctx, entry.URL))
		onlineCandidateMust(t, "online-real-dsh-original-25s-budget", hostColdBudget(ctx))
		hostColdAssertCredential(t, f.fixture, peers[index], index)
		hostColdAssertCatalog(t, ctx, f.fixture, peers[index], index)
		peers[index].owner.mu.Lock()
		calls, resumes := peers[index].owner.connects, peers[index].owner.resumes
		peers[index].owner.mu.Unlock()
		if calls != 1 || resumes != 0 {
			t.Fatal("online explicit workbench requested another runtime activation")
		}
		t.Logf("online-host-ready local=%s remote=%s service=%s user=%s network=%s attempt=%s generation=%d runtimeGeneration=%d elapsedMs=%d actualHTTP=true actualWebSocket=true originalSession=true", peers[index].original.DeviceID, active.State.PairID, f.authority.ServiceID, f.userSession.User.UserID, f.network.NetworkID, active.State.AttemptID, active.State.Generation, active.State.RuntimeGeneration, time.Since(started).Milliseconds())
	}
	if connected[0].State.AttemptID == connected[1].State.AttemptID {
		t.Fatal("online opposite directions shared one candidate attempt")
	}
}

func onlineCandidateHostTraffic(t *testing.T, ctx context.Context, f *onlineCandidateFixture, workers *onlineCandidateWorkers, peers [2]hostColdPeer, generations [2]uint64) [2]peersession.Connected {
	t.Helper()
	type result struct {
		index  int
		method string
		value  any
		err    error
	}
	start, completed := make(chan struct{}), make(chan result, 4)
	for index := range peers {
		for _, method := range []string{"directory.refresh", "peer.connect"} {
			data := map[string]any{}
			if method == "peer.connect" {
				data = map[string]any{"pairId": f.config[1-index].Device.DeviceID, "generation": generations[index], "requestWorkbench": true}
			}
			payload := json.RawMessage(envelope(t, f.authority.ServiceID, data))
			if !workers.start(ctx, func(operation context.Context) {
				select {
				case <-start:
				case <-operation.Done():
					return
				}
				value, err := hostColdCall(operation, peers[index].server, method, payload)
				workers.publish(operation, func() { completed <- result{index: index, method: method, value: value, err: err} })
			}) {
				t.Fatal("online concurrent traffic could not start within its original deadline")
			}
		}
	}
	close(start)
	var connected [2]peersession.Connected
	for range 4 {
		select {
		case answer := <-completed:
			onlineCandidateMust(t, "concurrent-online-host-"+answer.method, answer.err)
			onlineCandidateMust(t, "concurrent-online-host-budget", hostColdBudget(ctx))
			if answer.method == "directory.refresh" {
				hostColdAssertDirectory(t, f.fixture, hostColdDecode[helper.DirectoryView](t, answer.value))
			} else {
				connected[answer.index] = hostColdDecode[peersession.Connected](t, answer.value)
			}
		case <-ctx.Done():
			t.Fatal("online concurrent directory/candidate traffic exceeded original 25s deadline")
		}
	}
	return connected
}
