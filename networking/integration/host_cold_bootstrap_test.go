package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// These callbacks belong only to this test composition. Each binding names a
// separately launched real DSH; no provider or installed core is opened here.
type hostColdOwner struct {
	mu                sync.Mutex
	serviceID, pairID string
	binding           runtimebridge.Binding
	connects, resumes int
	receipts          chan peersession.State
	latest            peersession.State
	failure           error
	observe           func(peersession.State)
}

func (owner *hostColdOwner) recordState(serviceID string, state peersession.State) error {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	refuse := func(code string) error {
		owner.failure = errors.New(code)
		return owner.failure
	}
	if serviceID != owner.serviceID || state.PairID != owner.pairID || !protocol.ValidNonce(state.AttemptID) || !protocol.ValidGeneration(state.Generation) {
		return refuse("test.cold_state_scope_mismatch")
	}
	if state.Generation < owner.latest.Generation || state.Generation == owner.latest.Generation && owner.latest.AttemptID != "" && state.AttemptID != owner.latest.AttemptID {
		return refuse("test.cold_stale_or_aliased_state")
	}
	if owner.failure != nil {
		return owner.failure
	}
	select {
	case owner.receipts <- state:
		owner.latest = state
		if owner.observe != nil {
			owner.observe(state)
		}
		return nil
	default:
		return refuse("test.cold_state_receipt_overflow")
	}
}

func (owner *hostColdOwner) snapshot() (peersession.State, error) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.latest, owner.failure
}

func (owner *hostColdOwner) Call(_ context.Context, method string, payload any) (json.RawMessage, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	switch method {
	case "runtime.connect", "runtime.resume":
		var request struct {
			ServiceID string `json:"serviceId"`
			PairID    string `json:"pairId"`
		}
		if protocol.DecodeExact(encoded, &request) != nil || request.ServiceID != owner.serviceID || request.PairID != owner.pairID {
			return nil, errors.New("test.cold_runtime_scope_mismatch")
		}
		owner.mu.Lock()
		if method == "runtime.connect" {
			owner.connects++
		} else {
			owner.resumes++
		}
		owner.mu.Unlock()
		return json.Marshal(owner.binding)
	case "peer.state":
		var request struct {
			ServiceID string            `json:"serviceId"`
			State     peersession.State `json:"state"`
		}
		if protocol.DecodeExact(encoded, &request) != nil {
			return nil, errors.New("test.cold_state_scope_mismatch")
		}
		if err := owner.recordState(request.ServiceID, request.State); err != nil {
			return nil, err
		}
	case "directory.changed", "catalog.changed":
		// Notifications do not drive configure, restore, connect or runtime start.
	default:
		return nil, errors.New("test.cold_unexpected_callback")
	}
	return json.RawMessage(`{}`), nil
}

type hostColdPeer struct {
	host     *helper.Host
	server   core.Serve
	store    *certificateSecrets
	owner    *hostColdOwner
	session  []byte
	original controlplane.Device
}

func hostColdSeedAndRecreate(t *testing.T, f *realCoordinator, index int, runtimeURL string) hostColdPeer {
	t.Helper()
	store := &certificateSecrets{values: map[string][]byte{}}
	seed, configured, callbacks := certificateCore(t, f, store)
	device := f.config[index].Device
	must(t, seed.SaveCredential(f.authority.ServiceID, device, f.config[index].Private))
	session, err := store.Get("peer-user-session:" + f.authority.ServiceID)
	must(t, err)
	if !bytes.Equal(session, integrationSessionRecord(t, f.userSession)) {
		t.Fatal("initial persistence changed the original issued login")
	}
	seed.Close()
	callbacks.mu.Lock()
	seedRuntimeCalls := callbacks.runtimeCalls
	callbacks.mu.Unlock()
	if seedRuntimeCalls != 0 {
		t.Fatal("credential seeding requested a runtime")
	}
	owner := &hostColdOwner{serviceID: f.authority.ServiceID, pairID: f.config[1-index].Device.DeviceID,
		binding: runtimebridge.Binding{Generation: uint64(index + 1), URL: runtimeURL}, receipts: make(chan peersession.State, 128)}
	host := helper.New(f.ctx)
	root, err := x509.ParseCertificate(f.root)
	must(t, err)
	roots := x509.NewCertPool()
	roots.AddCert(root)
	host.SetRoots(roots)
	host.SetDeviceKeys(store)
	host.SetCatalog(configured.Catalog)
	host.BindMain(owner)
	t.Cleanup(host.Close)
	// Deliberately no configure/current/device.restore on the new Host. The
	// production restore must discover and confirm every persisted prerequisite.
	return hostColdPeer{host: host, server: core.Serve{Store: store, Peer: host, Catalog: configured.Catalog},
		store: store, owner: owner, session: session, original: device}
}

func hostColdDecode[T any](t *testing.T, value any) T {
	t.Helper()
	encoded, err := json.Marshal(value)
	must(t, err)
	var decoded T
	must(t, protocol.DecodeExact(encoded, &decoded))
	return decoded
}

func hostColdError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "test.cold_deadline_exceeded"
	}
	if errors.Is(err, context.Canceled) {
		return "test.cold_cancelled"
	}
	if code, ok := protocol.Refusal(err); ok {
		return code
	}
	return "test.cold_untyped_operation_failure"
}

func hostColdBudget(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, bounded := ctx.Deadline(); !bounded || !time.Now().Before(deadline) {
		return errors.New("test.cold_deadline_exceeded")
	}
	return nil
}

func hostColdCall(ctx context.Context, server core.Serve, method string, payload json.RawMessage) (any, error) {
	if err := hostColdBudget(ctx); err != nil {
		return nil, err
	}
	value, err := server.Handle(ctx, method, payload)
	if late := hostColdBudget(ctx); late != nil {
		return nil, late
	}
	return value, err
}

func hostColdTransportReady(state peersession.State) bool {
	return state.Stage == "connected" && state.RuntimeGeneration == 0 && state.Error == "" &&
		protocol.ValidNonce(state.AttemptID) && protocol.ValidGeneration(state.Generation)
}

func hostColdObserveTransport(ctx context.Context, owners [2]*hostColdOwner) ([2]peersession.State, error) {
	var current [2]peersession.State
	for {
		if err := hostColdBudget(ctx); err != nil {
			return current, err
		}
		for index, owner := range owners {
			state, err := owner.snapshot()
			if err != nil {
				return current, err
			}
			current[index] = state
		}
		if hostColdTransportReady(current[0]) && hostColdTransportReady(current[1]) {
			return current, hostColdBudget(ctx)
		}
		select {
		case <-ctx.Done():
			return current, ctx.Err()
		case <-owners[0].receipts:
		case <-owners[1].receipts:
		}
	}
}

func hostColdAssertCredential(t *testing.T, f *realCoordinator, peer hostColdPeer, index int) {
	t.Helper()
	stored, err := peer.host.LoadCredential(f.authority.ServiceID)
	must(t, err)
	if stored.DeviceID != peer.original.DeviceID || stored.UserID != peer.original.UserID || stored.Name != peer.original.Name ||
		stored.Endpoints != f.endpoints || !bytes.Equal(stored.ServiceKey, f.authority.PublicKey) ||
		!bytes.Equal(stored.PublicKey, peer.original.PublicKey) || !bytes.Equal(stored.Certificate, peer.original.Certificate) ||
		!bytes.Equal(stored.PrivateKey, f.config[index].Private) {
		t.Fatal("cold restore changed the original device credential or authority")
	}
	session, err := peer.store.Get("peer-user-session:" + f.authority.ServiceID)
	must(t, err)
	if !bytes.Equal(session, peer.session) {
		t.Fatal("cold restore rewrote the original durable login")
	}
	services := peer.host.RecordedCredentialServices()
	if len(services) != 1 || services[0] != f.authority.ServiceID {
		t.Fatal("cold restore changed the persisted service ownership")
	}
}

func hostColdAssertCatalog(t *testing.T, ctx context.Context, f *realCoordinator, peer hostColdPeer, index int) {
	t.Helper()
	value, err := hostColdCall(ctx, peer.server, "core.catalog_inspect", json.RawMessage(`{}`))
	must(t, err)
	saved := hostColdDecode[struct {
		Enabled  bool            `json:"enabled"`
		Revision string          `json:"revision"`
		Record   *catalog.Record `json:"record"`
	}](t, value)
	if !saved.Enabled || saved.Revision == "" || saved.Record == nil || len(saved.Record.Services) != 1 ||
		saved.Record.Services[0].ServiceID != f.authority.ServiceID || len(saved.Record.Computers) != 1 {
		t.Fatal("cold restore did not publish one fresh exact-scope catalog")
	}
	computer, remote := saved.Record.Computers[0], f.config[1-index].Device
	if computer.ConnectionID != remote.DeviceID || computer.PairID != remote.DeviceID || computer.ServiceID != f.authority.ServiceID ||
		computer.NetworkID != f.config[index].Pin.Pair.NetworkID || computer.LocalDeviceID != peer.original.DeviceID ||
		computer.RemoteDeviceID != remote.DeviceID || computer.UserID != f.userSession.User.UserID || computer.PairState != "active" ||
		computer.PairRevision != int64(f.config[index].Pin.Pair.Revision) ||
		computer.LocalPublicKey != base64.StdEncoding.EncodeToString(peer.original.PublicKey) ||
		computer.RemotePublicKey != base64.StdEncoding.EncodeToString(remote.PublicKey) {
		t.Fatal("fresh catalog changed the original pair network device or keys")
	}
}

func hostColdAssertDirectory(t *testing.T, f *realCoordinator, view helper.DirectoryView) {
	t.Helper()
	if !view.Known || view.ServiceID != f.authority.ServiceID || view.Revision == 0 || view.FetchedAt <= 0 || len(view.Networks) != 1 {
		t.Fatal("cold directory did not publish a known current service snapshot")
	}
	network := view.Networks[0]
	if network.NetworkID != f.config[0].Pin.Pair.NetworkID || network.UserID != f.userSession.User.UserID {
		t.Fatal("cold directory chose another account or network")
	}
	for _, entries := range [][]controlplane.DeviceEntry{view.Devices, network.Devices} {
		if len(entries) != 2 {
			t.Fatal("cold directory changed the original device set")
		}
		seen := map[string]bool{}
		for _, entry := range entries {
			var original *controlplane.Device
			for index := range 2 {
				if entry.DeviceID == f.config[index].Device.DeviceID {
					original = &f.config[index].Device
				}
			}
			if original == nil || seen[entry.DeviceID] || entry.UserID != f.userSession.User.UserID || entry.Name != original.Name || entry.Presence != "online" {
				t.Fatal("cold directory reported a false offline duplicate or foreign device")
			}
			seen[entry.DeviceID] = true
		}
	}
}

// This is a production Gin process plus two fresh production Host compositions,
// with test-only isolated secret stores and two real DSH children. It is not an
// OS credential-provider, binary-serve, Electron UI or physical-machine pass.
func TestHostsRealDSHSameNATColdRestoreDirectoryAndCandidates(t *testing.T) {
	// Start the required runtimes before server enrollment so their startup is
	// not an artificial pause that drains the coordinator's startup budget.
	var runtimes [2]string
	for index := range 2 {
		runtimes[index], _ = startRealDSH(t)
	}
	f := newFixture(t)
	binary, err := os.ReadFile(f.binary)
	must(t, err)
	t.Logf("host-cold-scope serverSha256=%x sameNAT=127.0.0.1 productionLimiterUnmodified=true sourceLimit=20 globalLimit=1000 phase=initial-persistence", sha256.Sum256(binary))
	var peers [2]hostColdPeer
	for index := range peers {
		peers[index] = hostColdSeedAndRecreate(t, f, index, runtimes[index])
	}
	started := time.Now()
	ctx, cancel := context.WithDeadline(f.ctx, started.Add(25*time.Second))
	defer cancel()
	start, restored := make(chan struct{}), make(chan int, 2)
	var initial sync.WaitGroup
	t.Cleanup(initial.Wait)
	for index := range peers {
		peers[index].owner.observe = func(state peersession.State) {
			t.Logf("host-cold-outbound local=%s remote=%s service=%s user=%s network=%s wireFence=not_exposed attempt=%s generation=%d stage=%s runtimeGeneration=%d code=%s elapsedMs=%d",
				peers[index].original.DeviceID, state.PairID, f.authority.ServiceID, f.userSession.User.UserID, f.config[index].Pin.Pair.NetworkID,
				state.AttemptID, state.Generation, state.Stage, state.RuntimeGeneration, state.Error, time.Since(started).Milliseconds())
		}
		initial.Add(1)
		go func() {
			defer initial.Done()
			<-start
			count := peers[index].host.RestoreOwnCredentials(ctx)
			t.Logf("host-cold-initial-return device=%s count=%d finalReady=false elapsedMs=%d", peers[index].original.DeviceID, count, time.Since(started).Milliseconds())
			restored <- count
		}()
	}
	close(start)
	for range peers {
		select {
		case count := <-restored:
			must(t, hostColdBudget(ctx))
			if count != 0 && count != 1 {
				t.Fatal("initial restore reported more than the original enrolled service", count)
			}
		case <-ctx.Done():
			t.Fatal("initial cold restore exceeded the shared deadline")
		}
	}
	// This is the one initial production serve scan, not RepairSignals, RetryNow
	// or another Restore. A pending bootstrap must finish and Wake its own engine.
	for index := range peers {
		peers[index].host.AutoConnectEngine().Reconcile(ctx)
		must(t, hostColdBudget(ctx))
	}
	transport, err := hostColdObserveTransport(ctx, [2]*hostColdOwner{peers[0].owner, peers[1].owner})
	if err != nil {
		t.Fatal("original bootstrap/engine did not establish both outbound transports within the shared deadline", hostColdError(err))
	}
	var generations [2]uint64
	for index := range peers {
		must(t, hostColdBudget(ctx))
		hostColdAssertCredential(t, f, peers[index], index)
		hostColdAssertCatalog(t, ctx, f, peers[index], index)
		peers[index].owner.mu.Lock()
		calls, resumes := peers[index].owner.connects, peers[index].owner.resumes
		peers[index].owner.mu.Unlock()
		if calls != 0 || resumes != 0 {
			t.Fatal("transport-only bootstrap invoked a runtime owner", calls, resumes)
		}
		generations[index] = transport[index].Generation + 1
		if !protocol.ValidGeneration(generations[index]) {
			t.Fatal("observed transport cannot admit a newer explicit generation")
		}
		must(t, hostColdBudget(ctx))
	}

	type result struct {
		index   int
		method  string
		value   any
		err     error
		elapsed time.Duration
	}
	traffic, completed := make(chan struct{}), make(chan result, 4)
	for index := range peers {
		for _, method := range []string{"directory.refresh", "peer.connect"} {
			data := map[string]any{}
			if method == "peer.connect" {
				data = map[string]any{"pairId": f.config[1-index].Device.DeviceID, "generation": generations[index], "requestWorkbench": true}
			}
			payload := json.RawMessage(envelope(t, f.authority.ServiceID, data))
			go func() {
				<-traffic
				value, err := hostColdCall(ctx, peers[index].server, method, payload)
				completed <- result{index: index, method: method, value: value, err: err, elapsed: time.Since(started)}
			}()
		}
	}
	close(traffic)
	var connected [2]peersession.Connected
	var failed bool
	var answers []result
	for range 4 {
		var answer result
		select {
		case answer = <-completed:
			must(t, hostColdBudget(ctx))
		case <-ctx.Done():
			t.Fatal("concurrent cold traffic exceeded the original shared deadline")
		}
		answers = append(answers, answer)
		t.Logf("host-cold-traffic device=%s operation=%s code=%s elapsedMs=%d", peers[answer.index].original.DeviceID, answer.method, hostColdError(answer.err), answer.elapsed.Milliseconds())
		if answer.err != nil {
			failed = true
		}
	}
	if failed {
		t.Fatal("concurrent directory or candidate operation failed with production limits enabled")
	}
	for _, answer := range answers {
		if answer.method == "directory.refresh" {
			hostColdAssertDirectory(t, f, hostColdDecode[helper.DirectoryView](t, answer.value))
		} else {
			connected[answer.index] = hostColdDecode[peersession.Connected](t, answer.value)
		}
	}
	for index, active := range connected {
		must(t, hostColdBudget(ctx))
		if active.State.Stage != "ready" || !protocol.ValidNonce(active.State.AttemptID) || active.State.Generation != generations[index] ||
			active.State.PairID != f.config[1-index].Device.DeviceID || active.State.RuntimeGeneration != peers[1-index].owner.binding.Generation ||
			active.URL == "" || active.URL == runtimes[1-index] {
			t.Fatal("cold candidate did not prove its exact committed runtime and gateway")
		}
		value, err := hostColdCall(ctx, peers[index].server, "peer.entry", json.RawMessage(envelope(t, f.authority.ServiceID,
			map[string]any{"pairId": active.State.PairID, "generation": active.State.Generation})))
		must(t, err)
		entry := hostColdDecode[struct {
			ServiceID string            `json:"serviceId"`
			State     peersession.State `json:"state"`
			URL       string            `json:"url"`
		}](t, value)
		if entry.ServiceID != f.authority.ServiceID || entry.State != active.State || entry.URL != active.URL {
			t.Fatal("cold current-entry readback changed committed candidate identity")
		}
		if err := runtimebridge.Probe(ctx, entry.URL); err != nil {
			t.Fatal("cold real DSH gateway probe failed", hostColdError(err))
		}
		must(t, hostColdBudget(ctx))
		hostColdAssertCredential(t, f, peers[index], index)
		hostColdAssertCatalog(t, ctx, f, peers[index], index)
		peers[index].owner.mu.Lock()
		calls, resumes := peers[index].owner.connects, peers[index].owner.resumes
		peers[index].owner.mu.Unlock()
		_, observerErr := peers[index].owner.snapshot()
		must(t, observerErr)
		if calls != 1 || resumes != 0 {
			t.Fatal("cold initial connection requested another runtime activation", calls, resumes)
		}
		canonical, err := f.client.ReadCertificate(ctx, peers[index].original.DeviceID, f.config[index].Private, f.authority)
		must(t, err)
		must(t, hostColdBudget(ctx))
		if canonical.DeviceID != peers[index].original.DeviceID || canonical.UserID != peers[index].original.UserID ||
			!bytes.Equal(canonical.PublicKey, peers[index].original.PublicKey) || !bytes.Equal(canonical.Certificate, peers[index].original.Certificate) {
			t.Fatal("cold authoritative device readback changed original enrollment")
		}
		t.Logf("host-cold-ready device=%s pair=%s network=%s attempt=%s generation=%d runtimeGeneration=%d elapsedMs=%d originalSession=true originalDevice=true", peers[index].original.DeviceID, active.State.PairID, f.config[index].Pin.Pair.NetworkID, active.State.AttemptID, active.State.Generation, active.State.RuntimeGeneration, time.Since(started).Milliseconds())
	}
	if connected[0].State.AttemptID == connected[1].State.AttemptID {
		t.Fatal("opposite cold directions shared one candidate attempt")
	}
	must(t, hostColdBudget(ctx))
}
