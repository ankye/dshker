// Package peersession composes the real coordinator, direct transport and DSH
// gateway. It has no filesystem, shell, test endpoint or credential persistence.
package peersession

import (
	"context"
	"crypto/ed25519"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

type Config struct {
	Endpoints  controlplane.Endpoints
	Authority  controlplane.Identity
	Device     controlplane.Device
	PrivateKey ed25519.PrivateKey
}
type State struct {
	PairID            string          `json:"pairId"`
	AttemptID         string          `json:"attemptId"`
	Generation        uint64          `json:"generation"`
	Stage             string          `json:"stage"`
	Error             string          `json:"error"`
	Path              peer.DirectPath `json:"path"`
	RuntimeGeneration uint64          `json:"runtimeGeneration"`
}

// Connected.URL is a main-only transient local URL; never project it into
// ordinary renderer connection state.
type Connected struct {
	State State  `json:"state"`
	URL   string `json:"url"`
}
type Manager struct {
	ctx             context.Context
	cancel          context.CancelFunc
	client          *controlplane.Client
	signals         *controlplane.Signals
	config          Config
	owner           runtimebridge.RuntimeOwner
	emit            func(State)
	mu              sync.Mutex
	pins            map[string]controlplane.PairIdentity
	revokedNetworks map[string]struct{}
	revokedPairs    map[string]string
	sessions        map[string]*session
	closed          bool
}
type session struct {
	lease     protocol.Lease
	transport *peer.Transport
	ctx       context.Context
	cancel    context.CancelFunc
	ready     chan struct{}
	done      chan struct{}
	mu        sync.Mutex
	result    Connected
	err       error
	mux       *peer.Mux
}

func newSession(parent context.Context) *session {
	ctx, cancel := context.WithCancel(parent)
	return &session{ctx: ctx, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{})}
}

func New(ctx context.Context, client *controlplane.Client, config Config, pins []controlplane.PairIdentity, owner runtimebridge.RuntimeOwner, emit func(State)) (*Manager, error) {
	if client == nil || owner == nil || emit == nil {
		return nil, errors.New("p2p.helper_configuration_required")
	}
	child, cancel := context.WithCancel(ctx)
	manager := &Manager{ctx: child, cancel: cancel, client: client, config: config, owner: owner, emit: emit, pins: make(map[string]controlplane.PairIdentity), sessions: make(map[string]*session)}
	for _, pin := range pins {
		if err := manager.Pin(pin); err != nil {
			cancel()
			return nil, err
		}
	}
	signals, err := client.Subscribe(child, config.Device.DeviceID)
	if err != nil {
		cancel()
		return nil, err
	}
	manager.signals = signals
	go manager.receive()
	return manager, nil
}

func (manager *Manager) Pin(pin controlplane.PairIdentity) error {
	if !protocol.ValidID(pin.Pair.NetworkID) || !protocol.ValidID(pin.Initiator.DeviceID) || !protocol.ValidID(pin.Target.DeviceID) || pin.Pair.Initiator != pin.Initiator.DeviceID || pin.Pair.Target != pin.Target.DeviceID || pin.Pair.Initiator == pin.Pair.Target {
		return errors.New("p2p.identity_mismatch")
	}
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	if !protocol.ValidID(pin.Pair.PairID) || pin.Pair.State != "active" || pin.Pair.Revision == 0 || local.DeviceID != manager.config.Device.DeviceID || !protocol.ValidID(local.UserID) || local.UserID != manager.config.Device.UserID || len(local.PublicKey) != ed25519.PublicKeySize || !ed25519.PublicKey(local.PublicKey).Equal(ed25519.PublicKey(manager.config.Device.PublicKey)) || remote.UserID != local.UserID || len(remote.PublicKey) != 32 {
		return errors.New("p2p.identity_mismatch")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return errors.New("p2p.helper_unavailable")
	}
	if _, revoked := manager.revokedNetworks[pin.Pair.NetworkID]; revoked {
		return errors.New("p2p.network_revoked")
	}
	if _, revoked := manager.revokedPairs[pin.Pair.PairID]; revoked {
		return errors.New("p2p.pair_unauthorized")
	}
	if previous, exists := manager.pins[pin.Pair.PairID]; exists && (previous.Pair.NetworkID != pin.Pair.NetworkID || previous.Pair.Revision > pin.Pair.Revision || previous.Pair.Initiator != pin.Pair.Initiator || previous.Pair.Target != pin.Pair.Target || !ed25519.PublicKey(previous.Initiator.PublicKey).Equal(ed25519.PublicKey(pin.Initiator.PublicKey)) || !ed25519.PublicKey(previous.Target.PublicKey).Equal(ed25519.PublicKey(pin.Target.PublicKey))) {
		return errors.New("p2p.identity_mismatch")
	}
	pin.Initiator.PublicKey = append([]byte(nil), pin.Initiator.PublicKey...)
	pin.Target.PublicKey = append([]byte(nil), pin.Target.PublicKey...)
	manager.pins[pin.Pair.PairID] = pin
	return nil
}

func (manager *Manager) Connect(ctx context.Context, pairID string, generation uint64) (Connected, error) {
	if ctx.Err() != nil {
		return Connected{}, ctx.Err()
	}
	if !protocol.ValidID(pairID) || generation == 0 {
		return Connected{}, errors.New("p2p.invalid_request")
	}
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return Connected{}, errors.New("p2p.helper_unavailable")
	}
	if _, exists := manager.pins[pairID]; !exists {
		manager.mu.Unlock()
		return Connected{}, errors.New("p2p.pair_unauthorized")
	}
	if _, exists := manager.sessions[pairID]; exists {
		manager.mu.Unlock()
		return Connected{}, errors.New("p2p.connection_busy")
	}
	connection := newSession(manager.ctx)
	manager.sessions[pairID] = connection
	manager.mu.Unlock()
	stopCancellation := context.AfterFunc(ctx, connection.cancel)
	defer stopCancellation()
	started := false
	defer func() {
		if !started {
			manager.finish(pairID, connection)
		}
	}()
	lease, err := manager.client.Begin(connection.ctx, pairID, generation)
	if err != nil {
		return Connected{}, err
	}
	_, err = manager.start(lease, connection)
	if err != nil {
		manager.end(lease)
		return Connected{}, err
	}
	started = true
	deadline, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	offer, err := connection.transport.Offer(deadline)
	if err == nil {
		err = manager.signals.Send(deadline, offer)
	}
	cancel()
	if err != nil {
		connection.cancel()
		<-connection.done
		return Connected{}, err
	}
	select {
	case <-ctx.Done():
		connection.cancel()
		<-connection.done
		return Connected{}, ctx.Err()
	case <-connection.ctx.Done():
		<-connection.done
		return Connected{}, errors.New("p2p.connection_cancelled")
	case <-connection.ready:
		connection.mu.Lock()
		result, resultErr := connection.result, connection.err
		connection.mu.Unlock()
		if resultErr != nil {
			<-connection.done
			return Connected{}, resultErr
		}
		if connection.ctx.Err() != nil || ctx.Err() != nil {
			connection.cancel()
			<-connection.done
			return Connected{}, errors.New("p2p.connection_cancelled")
		}
		return result, nil
	}
}

func (manager *Manager) finish(pairID string, connection *session) {
	connection.cancel()
	manager.mu.Lock()
	if manager.sessions[pairID] == connection {
		delete(manager.sessions, pairID)
	}
	close(connection.done)
	manager.mu.Unlock()
}
func (manager *Manager) end(lease protocol.Lease) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	manager.client.End(ctx, lease.PairID, lease.AttemptID)
}
func (manager *Manager) Disconnect(pairID string) error {
	manager.mu.Lock()
	connection, exists := manager.sessions[pairID]
	manager.mu.Unlock()
	if !exists {
		return errors.New("p2p.not_connected")
	}
	connection.cancel()
	<-connection.done
	return nil
}
func (manager *Manager) InvalidateRuntime(generation uint64) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, connection := range manager.sessions {
		if connection.transport == nil || connection.lease.ToDeviceID != manager.config.Device.DeviceID {
			continue
		}
		connection.mu.Lock()
		matches := connection.result.State.RuntimeGeneration == 0 || connection.result.State.RuntimeGeneration == generation
		connection.mu.Unlock()
		if matches {
			connection.cancel()
		}
	}
}
func (manager *Manager) Close() {
	manager.mu.Lock()
	manager.closed = true
	pending := make([]<-chan struct{}, 0, len(manager.sessions))
	for _, connection := range manager.sessions {
		pending = append(pending, connection.done)
	}
	manager.mu.Unlock()
	manager.cancel()
	manager.signals.Close()
	for _, done := range pending {
		<-done
	}
}

func (manager *Manager) start(lease protocol.Lease, reserved *session) (*session, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	pin, exists := manager.pins[lease.PairID]
	if !exists || manager.closed {
		return nil, errors.New("p2p.pair_unauthorized")
	}
	current, busy := manager.sessions[lease.PairID]
	if (reserved == nil && busy) || (reserved != nil && (!busy || current != reserved)) {
		return nil, errors.New("p2p.connection_busy")
	}
	if reserved != nil && reserved.ctx.Err() != nil {
		return nil, errors.New("p2p.connection_cancelled")
	}
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	connection := reserved
	if connection == nil {
		connection = newSession(manager.ctx)
	}
	scope := protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}
	transport, err := peer.NewTransport(connection.ctx, peer.TransportOptions{UserID: local.UserID, NetworkID: pin.Pair.NetworkID, STUNAddress: manager.config.Endpoints.STUNAddress, LocalDeviceID: local.DeviceID, PeerDeviceID: remote.DeviceID, PrivateKey: manager.config.PrivateKey, PeerKey: remote.PublicKey, ServiceKey: manager.config.Authority.PublicKey, Scope: scope, Revision: pin.Pair.Revision, Lease: lease})
	if err != nil {
		connection.cancel()
		return nil, err
	}
	connection.lease, connection.transport = lease, transport
	manager.sessions[lease.PairID] = connection
	go manager.run(connection)
	return connection, nil
}

func (manager *Manager) receive() {
	for event := range manager.signals.Events() {
		if event.Type == "attempt" {
			if event.Lease.FromDeviceID != manager.config.Device.DeviceID {
				manager.start(event.Lease, nil)
			}
			continue
		}
		manager.mu.Lock()
		connection := manager.sessions[event.PairID]
		if event.Type == "signal" {
			connection = manager.sessions[event.Signal.PairID]
		}
		if event.Type == "revoked" {
			delete(manager.pins, event.PairID)
			if connection != nil {
				connection.cancel()
			}
		}
		negotiating := connection != nil && connection.transport != nil
		manager.mu.Unlock()
		if !negotiating {
			continue
		}
		if event.Type == "revoked" {
			connection.cancel()
			continue
		}
		if event.Signal.AttemptID != connection.lease.AttemptID {
			continue
		}
		ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
		var err error
		if event.Signal.Type == "offer" {
			var answer protocol.Signal
			answer, err = connection.transport.AcceptOffer(ctx, event.Signal)
			if err == nil {
				err = manager.signals.Send(ctx, answer)
			}
		} else {
			err = connection.transport.AcceptAnswer(event.Signal)
		}
		cancel()
		if err != nil {
			connection.cancel()
		}
	}
	// Loss of signaling forbids new negotiation, but active data stays until
	// its existing lease expires; Transport owns this deadline.
}

func (manager *Manager) run(connection *session) {
	renewed := make(chan struct{})
	go func() { defer close(renewed); manager.renew(connection) }()
	state := State{PairID: connection.lease.PairID, AttemptID: connection.lease.AttemptID, Generation: connection.lease.Generation, Stage: "punching"}
	manager.emit(state)
	defer func() {
		connection.cancel()
		connection.transport.Close()
		<-renewed
		if state.Stage != "failed" {
			state.Stage = "disconnected"
		}
		manager.emit(state)
		manager.end(connection.lease)
		manager.finish(state.PairID, connection)
	}()
	deadline, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	err := connection.transport.WaitReady(deadline)
	cancel()
	var gateway *runtimebridge.Gateway
	var mux *peer.Mux
	var binding runtimebridge.Binding
	if err == nil {
		state.Path, err = connection.transport.Path()
	}
	if err == nil {
		state.Stage = "starting-runtime"
		manager.emit(state)
		gateway, mux, binding, err = runtimebridge.Establish(connection.ctx, connection.transport, connection.lease, connection.lease.FromDeviceID == manager.config.Device.DeviceID, manager.runtimeOwner(connection))
		if err == nil {
			connection.mu.Lock()
			connection.mux = mux
			connection.mu.Unlock()
		}
	}
	if gateway != nil {
		defer gateway.Close()
	}
	if mux != nil {
		defer mux.Close()
	}
	if err == nil && gateway.URL != "" {
		err = runtimebridge.Probe(connection.ctx, gateway.URL)
	}
	if err == nil && connection.ctx.Err() != nil {
		err = errors.New("p2p.connection_cancelled")
	}
	state.RuntimeGeneration = binding.Generation
	connection.mu.Lock()
	connection.err = err
	if err == nil {
		state.Stage = "ready"
		connection.result = Connected{State: state, URL: gateway.URL}
	} else {
		state.Stage = "failed"
		state.Error = "p2p.runtime_unavailable"
	}
	connection.mu.Unlock()
	close(connection.ready)
	manager.emit(state)
	if err != nil {
		return
	}
	select {
	case <-connection.ctx.Done():
	case <-connection.transport.Done():
	case <-gateway.Done():
	}
}

// Record the binding before exposing it to the authenticated peer. Invalidation
// also cancels incoming sessions whose owner request has not completed yet.
func (manager *Manager) runtimeOwner(connection *session) runtimebridge.RuntimeOwner {
	return func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		binding, err := manager.owner(ctx, pairID)
		if err != nil {
			return runtimebridge.Binding{}, err
		}
		manager.mu.Lock()
		defer manager.mu.Unlock()
		if connection.ctx.Err() != nil || manager.closed {
			return runtimebridge.Binding{}, errors.New("p2p.runtime_invalidated")
		}
		connection.mu.Lock()
		connection.result.State.RuntimeGeneration = binding.Generation
		connection.mu.Unlock()
		return binding, nil
	}
}

func (manager *Manager) renew(connection *session) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-connection.ctx.Done():
			return
		case <-ticker.C:
			lease, err := manager.client.RenewLease(connection.ctx, connection.lease.PairID, connection.lease.AttemptID)
			if err == nil {
				err = connection.transport.UpdateLease(lease)
			}
			if err != nil && err.Error() != "p2p.server_unavailable" {
				connection.cancel()
				return
			}
		}
	}
}

// RemoteRoots reads the authorized roots the connected peer's user granted.
//
// The pair must already be connected: this reuses the established direct
// transport and never opens a side channel or contacts the coordinator.
func (manager *Manager) RemoteRoots(ctx context.Context, pairID string) ([]runtimebridge.Root, error) {
	mux, err := manager.connectedMux(pairID)
	if err != nil {
		return nil, err
	}
	return runtimebridge.RequestRoots(ctx, mux)
}

// RemoteDirectory reads one bounded page inside an authorized remote root.
//
// `ref` must be an opaque reference the target issued; this side never builds
// one from a path, so it cannot widen the granted scope.
func (manager *Manager) RemoteDirectory(ctx context.Context, pairID string, rootID string, ref string, offset int, limit int) ([]runtimebridge.Entry, int, error) {
	mux, err := manager.connectedMux(pairID)
	if err != nil {
		return nil, 0, err
	}
	return runtimebridge.RequestDirectory(ctx, mux, rootID, ref, offset, limit)
}

func (manager *Manager) connectedMux(pairID string) (*peer.Mux, error) {
	if !protocol.ValidID(pairID) {
		return nil, errors.New("p2p.invalid_request")
	}
	manager.mu.Lock()
	connection, exists := manager.sessions[pairID]
	manager.mu.Unlock()
	if !exists {
		return nil, errors.New("p2p.not_connected")
	}
	connection.mu.Lock()
	mux := connection.mux
	connection.mu.Unlock()
	if mux == nil {
		return nil, errors.New("p2p.not_connected")
	}
	return mux, nil
}
