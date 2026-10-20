//go:build live

package integration

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// This test-only composition exercises the production Engine and Manager with
// an isolated, persisted catalog. It is not Mac binary serve, OS-store or UI
// acceptance. The borrowed Manager retains its own lifecycle and runtime owner.
type recoveryMacAuto struct {
	mu               sync.Mutex
	ctx              context.Context
	cancel           context.CancelFunc
	store            *catalog.Store
	service          string
	pair             string
	manager          *peersession.Manager
	engine           *autoconnect.Engine
	events           chan<- peersession.State
	current          peersession.State
	ownedGenerations map[uint64]string
	lastIssued       uint64
	attempts         uint64
	started          bool
	closed           bool
	done             chan struct{}
	engineDone       chan struct{}
}

func recoveryMacAutoOwner(t *testing.T, parent context.Context, f *realCoordinator, events chan<- peersession.State) *recoveryMacAuto {
	t.Helper()
	if parent == nil || f == nil || events == nil {
		t.Fatal("Mac automatic recovery requires its live coordinator, lifetime and state observer")
	}
	store, err := catalog.Open(t.TempDir())
	must(t, err)
	empty, err := store.Enable()
	must(t, err)
	local, remote, pin := f.config[1].Device, f.config[0].Device, f.config[1].Pin
	record := empty.Record
	record.Services = []catalog.Service{{
		ServiceID: f.authority.ServiceID, DisplayName: "recovery-coordinator",
		HTTPSOrigin: f.config[1].Endpoints.HTTPSOrigin, WSSURL: f.config[1].Endpoints.WSSURL,
		STUNAddress: f.config[1].Endpoints.STUNAddress,
		PublicKey:   base64.StdEncoding.EncodeToString(f.authority.PublicKey),
		Certificate: base64.StdEncoding.EncodeToString(f.authority.Certificate),
	}}
	record.Computers = []catalog.Computer{{
		ConnectionID: remote.DeviceID, ServiceID: f.authority.ServiceID, DisplayName: remote.Name,
		PairID: remote.DeviceID, NetworkID: pin.Pair.NetworkID, LocalDeviceID: local.DeviceID,
		RemoteDeviceID: remote.DeviceID, UserID: local.UserID,
		LocalPublicKey: base64.StdEncoding.EncodeToString(local.PublicKey), RemotePublicKey: base64.StdEncoding.EncodeToString(remote.PublicKey),
		PairRevision: int64(pin.Pair.Revision), PairState: pin.Pair.State,
	}}
	committed, err := store.Commit(empty.Revision, record)
	must(t, err)
	readback, err := store.Inspect()
	must(t, err)
	if readback == nil || readback.Revision != committed.Revision || len(readback.Record.Computers) != 1 || readback.Record.Computers[0] != record.Computers[0] {
		t.Fatal("Mac automatic owner did not read back its exact authorized temporary catalog")
	}
	ctx, cancel := context.WithCancel(parent)
	owner := &recoveryMacAuto{
		ctx: ctx, cancel: cancel, store: store, service: f.authority.ServiceID, pair: remote.DeviceID,
		events: events, ownedGenerations: make(map[uint64]string), done: make(chan struct{}), engineDone: make(chan struct{}),
	}
	owner.bindEngineLifecycle()
	t.Cleanup(owner.Close)
	return owner
}

func (owner *recoveryMacAuto) bindEngineLifecycle() {
	owner.engine = autoconnect.New(autoconnect.Options{
		Intents: owner.intents, Stage: owner.stage, Connect: owner.connect,
		CodeOf: func(err error) string {
			code, _ := protocol.Refusal(err)
			return code
		},
	})
	// Cancel the engine even if the periodic worker is awaiting a real connect.
	// Close joins this callback as well as the worker and engine retry goroutines.
	context.AfterFunc(owner.ctx, func() {
		owner.engine.Close()
		close(owner.engineDone)
	})
}

func (owner *recoveryMacAuto) BindManager(t *testing.T, manager *peersession.Manager) {
	t.Helper()
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if manager == nil || owner.manager != nil || owner.started || owner.closed {
		t.Fatal("Mac automatic owner must bind exactly one real manager before starting")
	}
	owner.manager = manager
}

// Observe never starts, retries or repairs anything. Inbound sessions share the
// public state shape, so only generations issued for this outbound owner enter
// its cache; every event still reaches the existing test observer unchanged.
func (owner *recoveryMacAuto) Observe(state peersession.State) {
	owner.mu.Lock()
	owner.observeLocked(state)
	owner.mu.Unlock()
	select {
	case owner.events <- state:
	case <-owner.ctx.Done():
	}
}

// This is the production Manager's notification hook, not an observer retry.
// Before Start this test has not admitted an automatic recovery owner yet.
func (owner *recoveryMacAuto) Wake(pair string) {
	owner.mu.Lock()
	active := owner.started && !owner.closed && pair == owner.pair
	owner.mu.Unlock()
	if active {
		owner.engine.Wake(autoconnect.Intent{ServiceID: owner.service, PairID: pair})
	}
}

func (owner *recoveryMacAuto) observeLocked(state peersession.State) {
	attempt, owned := owner.ownedGenerations[state.Generation]
	if !owned || state.PairID != owner.pair || state.AttemptID == "" || state.Generation < owner.current.Generation || (attempt != "" && attempt != state.AttemptID) {
		return
	}
	owner.ownedGenerations[state.Generation] = state.AttemptID
	owner.current = state
}

func (owner *recoveryMacAuto) Start(t *testing.T, initial peersession.State) {
	t.Helper()
	owner.mu.Lock()
	manager := owner.manager
	invalid := owner.closed || owner.started || manager == nil
	owner.mu.Unlock()
	if invalid || initial.PairID != owner.pair || initial.Stage != "ready" || initial.Generation == 0 || initial.AttemptID == "" || initial.RuntimeGeneration == 0 || initial.Error != "" {
		t.Fatal("Mac automatic recovery may start only after the single explicit workbench open is ready")
	}
	owner.mu.Lock()
	owner.current = initial
	owner.lastIssued = initial.Generation
	owner.ownedGenerations[initial.Generation] = initial.AttemptID
	owner.mu.Unlock()
	entry, err := manager.Entry(owner.pair, initial.Generation)
	must(t, err)
	if entry.State != initial || entry.URL == "" || !manager.WorkbenchRequested(owner.pair) {
		t.Fatal("Mac automatic recovery did not read back the initially admitted outbound workbench intent")
	}
	intents, err := owner.intents(owner.ctx)
	must(t, err)
	if len(intents) != 1 || intents[0].ServiceID != owner.service || intents[0].PairID != owner.pair {
		t.Fatal("Mac automatic recovery started without its exact active catalog intent")
	}
	owner.mu.Lock()
	if owner.closed || owner.started || owner.current != initial {
		owner.mu.Unlock()
		t.Fatal("Mac automatic recovery was closed, started or superseded while initial readback was pending")
	}
	owner.started = true
	owner.mu.Unlock()
	t.Logf("production-recovery-owner tier=production-autoconnect-engine+manager direction=mac-to-windows periodicSweep=5s eventWake=true service=%s pair=%s initialGeneration=%d initialAttempt=%s osStore=false binaryServe=false fullUI=false", owner.service, owner.pair, initial.Generation, initial.AttemptID)
	go owner.run()
}

func (owner *recoveryMacAuto) run() {
	defer close(owner.done)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if owner.ctx.Err() != nil {
			return
		}
		owner.mu.Lock()
		manager := owner.manager
		owner.mu.Unlock()
		// Match serve's signal-repair-before-reconcile ordering. The Connect
		// callback repeats repair and returns its real error to Engine policy.
		_ = manager.ReconnectSignals(owner.ctx)
		owner.engine.Reconcile(owner.ctx)
		select {
		case <-owner.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (owner *recoveryMacAuto) intents(ctx context.Context) ([]autoconnect.Intent, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	snapshot, err := owner.store.Inspect()
	if err != nil {
		return nil, err
	}
	if snapshot == nil {
		return nil, errors.New("p2p.catalog_unavailable")
	}
	intents := make([]autoconnect.Intent, 0, len(snapshot.Record.Computers))
	for _, computer := range snapshot.Record.Computers {
		if computer.PairState == "active" {
			intents = append(intents, autoconnect.Intent{ServiceID: computer.ServiceID, PairID: computer.PairID})
		}
	}
	return intents, nil
}

func (owner *recoveryMacAuto) stage(service, pair string) autoconnect.ConnectionState {
	owner.mu.Lock()
	manager, state := owner.manager, owner.current
	owner.mu.Unlock()
	if service != owner.service || pair != owner.pair || manager == nil {
		return autoconnect.ConnectionState{}
	}
	return autoconnect.ConnectionState{Stage: state.Stage, Error: state.Error, WorkbenchRequested: manager.WorkbenchRequested(pair)}
}

func (owner *recoveryMacAuto) connect(ctx context.Context, service, pair string) error {
	intents, err := owner.intents(ctx)
	if err != nil {
		return err
	}
	authorized := false
	for _, intent := range intents {
		authorized = authorized || intent.ServiceID == service && intent.PairID == pair
	}
	if !authorized {
		return errors.New("p2p.pair_unauthorized")
	}
	owner.mu.Lock()
	if owner.closed || !owner.started || owner.manager == nil || service != owner.service || pair != owner.pair {
		owner.mu.Unlock()
		return errors.New("p2p.service_unconfigured")
	}
	generation, err := recoveryMacNextGeneration(owner.current.Generation, owner.lastIssued)
	if err != nil {
		owner.mu.Unlock()
		return err
	}
	owner.lastIssued = generation
	for owned := range owner.ownedGenerations {
		if owned != owner.current.Generation {
			delete(owner.ownedGenerations, owned)
		}
	}
	owner.ownedGenerations[generation] = ""
	owner.attempts++
	manager := owner.manager
	owner.mu.Unlock()
	if err := manager.ReconnectSignals(ctx); err != nil {
		return err
	}
	_, err = manager.Reconnect(ctx, pair, generation)
	return err
}

func recoveryMacNextGeneration(current, previous uint64) (uint64, error) {
	if current < previous {
		current = previous
	}
	if current == ^uint64(0) {
		return 0, errors.New("p2p.stale_generation")
	}
	return current + 1, nil
}

func (owner *recoveryMacAuto) Current() (peersession.State, bool) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.current, owner.started && !owner.closed && owner.current.AttemptID != ""
}

func (owner *recoveryMacAuto) Attempts() uint64 {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.attempts
}

func (owner *recoveryMacAuto) Close() {
	owner.mu.Lock()
	if !owner.closed {
		owner.closed = true
		if !owner.started {
			close(owner.done)
		}
	}
	owner.mu.Unlock()
	owner.cancel()
	<-owner.engineDone
	<-owner.done
}
