// Package peersession composes the real coordinator, direct transport and DSH
// gateway. It has no filesystem, shell, test endpoint or credential persistence.
package peersession

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
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
	signals         *signaling
	config          Config
	owner           runtimebridge.RuntimeOwner
	emit            func(State)
	mu              sync.Mutex
	pins            map[string]controlplane.PairIdentity
	revokedNetworks map[string]struct{}
	revokedPairs    map[string]string
	sessions        map[string]*session
	// inbound holds the sessions this device answered, one per pair: the far
	// side connected to us. A pair can carry one session in each direction at
	// the same time — each machine's own Run tab is an outbound session, and the
	// far machine's tab is this one — so sharing one slot meant whichever side
	// dialled first kept the other side's "connect" answering p2p.connection_busy
	// forever, with a tab that showed the inbound session's stage and no address
	// of its own to load.
	inbound map[string]*session
	// endpoints outlive any one session: a browser tab or a desktop client left
	// pointed at a pair's gateway must keep working across a reconnect, so the
	// gateway is only closed when the pair itself stops being pinned — never
	// when a session inside it ends. Establish attaches each rebuilt session's
	// mux to the same Endpoint instead of the run creating a fresh one.
	endpoints map[string]*runtimebridge.Endpoint
	// inboundEndpoints is that long-lived attachment for answered sessions: the
	// served runtime is not the browsed one, so the two must never share an
	// Endpoint — an inbound session reusing the browser Endpoint reported no
	// local address, and the outbound attempt after it answered an empty URL.
	inboundEndpoints map[string]*runtimebridge.Endpoint
	closed           bool
	turnFetched      bool
	turnCreds        controlplane.TurnCredentials
	turnErr          error
}
type session struct {
	PairID    string
	lease     protocol.Lease
	transport *peer.Transport
	ctx       context.Context
	cancel    context.CancelFunc
	ready     chan struct{}
	done      chan struct{}
	mu        sync.Mutex
	result    Connected
	err       error
	// refusal is the named code for a failed attempt, so a caller that returns
	// the failure to the shell does not hand it the raw transport sentence.
	refusal string
	// finishOnce makes retiring a session idempotent; see Manager.finish.
	finishOnce sync.Once
	mux        *peer.Mux
	endpoint   *runtimebridge.Endpoint
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
	manager := &Manager{ctx: child, cancel: cancel, client: client, config: config, owner: owner, emit: emit, pins: make(map[string]controlplane.PairIdentity), sessions: make(map[string]*session), inbound: make(map[string]*session), endpoints: make(map[string]*runtimebridge.Endpoint), inboundEndpoints: make(map[string]*runtimebridge.Endpoint)}
	for _, pin := range pins {
		if err := manager.Pin(pin); err != nil {
			cancel()
			return nil, err
		}
	}
	signals, err := newSignaling(child, func(ctx context.Context, deviceID string) (subscription, error) {
		return client.Subscribe(ctx, deviceID)
	}, config.Device.DeviceID, manager.receive)
	if err != nil {
		cancel()
		return nil, err
	}
	manager.signals = signals
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
	pin, exists := manager.pins[pairID]
	if !exists {
		manager.mu.Unlock()
		return Connected{}, errors.New("p2p.pair_unauthorized")
	}
	if _, exists := manager.sessions[pairID]; exists {
		manager.mu.Unlock()
		return Connected{}, errors.New("p2p.connection_busy")
	}
	connection := newSession(manager.ctx)
	connection.PairID = pairID
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
	// The coordinator authorizes an attempt by network co-membership: the
	// request targets the far device identity of the confirmed pair.
	target, err := manager.targetDevice(pin)
	if err != nil {
		return Connected{}, err
	}
	lease, err := manager.client.Begin(connection.ctx, target, generation)
	if err != nil {
		return Connected{}, err
	}
	_, err = manager.start(pairID, lease, connection)
	if err != nil {
		manager.end(lease)
		return Connected{}, err
	}
	started = true
	deadline, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	offer, err := connection.transport.Offer(deadline)
	if err == nil {
		err = manager.signals.send(deadline, offer)
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
		result, resultErr, refusal := connection.result, connection.err, connection.refusal
		connection.mu.Unlock()
		if resultErr != nil {
			<-connection.done
			// The attempt already produced a named refusal for the state the shell
			// renders. Returning the raw cause instead would hand the shell a
			// transport sentence that the private channel can only collapse to
			// p2p.operation_failed, which is the one thing 3.8 exists to prevent.
			if refusal != "" {
				return Connected{}, errors.New(refusal)
			}
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

// namedRefusal reports why an attempt failed.
//
// The renderer only accepts named p2p codes, so an unnamed error is replaced by
// a generic one; a named refusal is passed through. Overwriting every failure
// with one constant made a transport failure and a missing remote runtime
// indistinguishable from the UI, which is exactly the question being asked.
func namedRefusal(err error, transportReady bool) string {
	if code, ok := protocol.Refusal(err); ok {
		return code
	}
	if !transportReady {
		// A deadline here means neither the direct path nor the opaque TURN relay
		// fallback came up, so the honest refusal is that the two networks cannot
		// reach each other.
		return "p2p.direct_unavailable"
	}
	return "p2p.runtime_unavailable"
}

// finish retires a session exactly once.
//
// Both the connecting caller and the session runner can reach it — the caller
// abandons an attempt whose transport failed while the runner is still unwinding
// — and closing an already closed channel panics the whole core, which takes
// every pair down with it until the application is restarted. The once also
// keeps the waiters correct: whoever arrives second still observes a closed
// done.
func (manager *Manager) finish(pairID string, connection *session) {
	connection.cancel()
	manager.mu.Lock()
	if manager.sessions[pairID] == connection {
		delete(manager.sessions, pairID)
	}
	if manager.inbound[pairID] == connection {
		delete(manager.inbound, pairID)
	}
	manager.mu.Unlock()
	connection.finishOnce.Do(func() { close(connection.done) })
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
	// InvalidateRuntime is asked to drop the sessions bound to a runtime this
	// device serves, which are the answered ones; the dialled ones browse the
	// far side's runtime and cannot be bound to a local generation.
	for _, connection := range manager.inbound {
		if connection.transport == nil {
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
	pending := make([]<-chan struct{}, 0, len(manager.sessions)+len(manager.inbound))
	for _, connection := range manager.sessions {
		pending = append(pending, connection.done)
	}
	for _, connection := range manager.inbound {
		pending = append(pending, connection.done)
	}
	endpoints := make([]*runtimebridge.Endpoint, 0, len(manager.endpoints)+len(manager.inboundEndpoints))
	for _, endpoint := range manager.endpoints {
		endpoints = append(endpoints, endpoint)
	}
	for _, endpoint := range manager.inboundEndpoints {
		endpoints = append(endpoints, endpoint)
	}
	manager.endpoints = make(map[string]*runtimebridge.Endpoint)
	manager.inboundEndpoints = make(map[string]*runtimebridge.Endpoint)
	manager.mu.Unlock()
	manager.cancel()
	manager.signals.close()
	for _, done := range pending {
		<-done
	}
	// Every gateway this manager ever opened ends with it: the process losing
	// its P2P session is not a drop the shell will reconnect from, unlike a
	// session inside a still-pinned pair dropping.
	for _, endpoint := range endpoints {
		endpoint.Close()
	}
}

func (manager *Manager) start(pairID string, lease protocol.Lease, reserved *session) (*session, error) {
	// Fetch relay credentials before taking the manager lock: the fetch may
	// hit the network, and a fetch inside the lock would self-deadlock when
	// turnEndpoints re-acquires it (start already holds it), blocking every
	// other session path. A fetch failure simply leaves the direct-only path.
	creds, credsErr := manager.turnEndpoints(manager.ctx)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	pin, exists := manager.pins[pairID]
	if !exists || manager.closed {
		return nil, errors.New("p2p.pair_unauthorized")
	}
	// Outbound attempts reserve their slot in Connect; an answered attempt owns
	// the inbound one. The two never block each other: a pair can be dialled and
	// answered at the same time, each direction serving the other machine's tab.
	dialed, dialedBusy := manager.sessions[pairID]
	if reserved != nil && (!dialedBusy || dialed != reserved) {
		return nil, errors.New("p2p.connection_busy")
	}
	if reserved == nil {
		if _, answered := manager.inbound[pairID]; answered {
			return nil, errors.New("p2p.connection_busy")
		}
	}
	if reserved != nil && reserved.ctx.Err() != nil {
		return nil, errors.New("p2p.connection_cancelled")
	}
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	// The lease names the far side by device identity (co-membership), the
	// pinned pair record only supplies its key and grants the local scope.
	if reserved != nil && remote.DeviceID != lease.ToDeviceID {
		return nil, errors.New("p2p.identity_mismatch")
	}
	if reserved == nil && remote.DeviceID != lease.FromDeviceID {
		return nil, errors.New("p2p.pair_unauthorized")
	}
	connection := reserved
	if connection == nil {
		connection = newSession(manager.ctx)
	}
	scope := protocol.SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}
	turnURL, turnUsername, turnCredential := "", "", ""
	if credsErr == nil && len(creds.URLs) > 0 {
		turnURL, turnUsername, turnCredential = creds.URLs[0], creds.Username, creds.Credential
	}
	transport, err := peer.NewTransport(connection.ctx, peer.TransportOptions{UserID: local.UserID, NetworkID: pin.Pair.NetworkID, STUNAddress: manager.config.Endpoints.STUNAddress, TurnURL: turnURL, TurnUsername: turnUsername, TurnCredential: turnCredential, LocalDeviceID: local.DeviceID, PeerDeviceID: remote.DeviceID, PrivateKey: manager.config.PrivateKey, PeerKey: remote.PublicKey, ServiceKey: manager.config.Authority.PublicKey, Scope: scope, Revision: lease.Revision, Lease: lease})
	if err != nil {
		connection.cancel()
		return nil, err
	}
	connection.PairID = pairID
	connection.lease, connection.transport = lease, transport
	if reserved == nil {
		manager.inbound[pairID] = connection
	} else {
		manager.sessions[pairID] = connection
	}
	go manager.run(connection)
	return connection, nil
}

// targetDevice returns the far device identity of a pinned pair, normalizing
// the pair so the local device is the initiator or the target side.
// turnEndpoints returns the device-scoped TURN relay credentials, fetched at
// most once from the coordinator and cached for the manager lifetime. A fetch
// failure leaves the session on the direct path only; the relay is an
// enhancement, never a requirement.
func (manager *Manager) turnEndpoints(ctx context.Context) (controlplane.TurnCredentials, error) {
	manager.mu.Lock()
	if manager.turnFetched {
		creds, err := manager.turnCreds, manager.turnErr
		manager.mu.Unlock()
		return creds, err
	}
	manager.mu.Unlock()
	// Fetch outside the mutex: the coordinator call may be slow or fail
	// (server restart, transient network); holding manager.mu across it would
	// block every other session path. The first writer wins the cache.
	creds, err := manager.client.TurnCredentials(ctx)
	manager.mu.Lock()
	if !manager.turnFetched {
		manager.turnFetched = true
		manager.turnCreds = creds
		manager.turnErr = err
	}
	result, finalErr := manager.turnCreds, manager.turnErr
	manager.mu.Unlock()
	return result, finalErr
}

func (manager *Manager) targetDevice(pin controlplane.PairIdentity) (string, error) {
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	if local.DeviceID != manager.config.Device.DeviceID || local.DeviceID == remote.DeviceID {
		return "", errors.New("p2p.identity_mismatch")
	}
	return remote.DeviceID, nil
}

// pairForRemoteLocked finds the confirmed pair whose far device and network
// match an incoming attempt. Caller holds manager.mu.
func (manager *Manager) pairForRemoteLocked(remoteDeviceID, networkID string) (string, bool) {
	for pairID, pin := range manager.pins {
		local, remote := pin.Initiator, pin.Target
		if local.DeviceID != manager.config.Device.DeviceID {
			local, remote = remote, local
		}
		if remote.DeviceID == remoteDeviceID && pin.Pair.NetworkID == networkID && pin.Pair.State == "active" {
			return pairID, true
		}
	}
	return "", false
}

// sessionByAttemptLocked finds the session whose lease carries an attempt id.
// Caller holds manager.mu. Both directions are searched: an attempt id names
// one attempt, but dialled and answered sessions coexist for one pair.
func (manager *Manager) sessionByAttemptLocked(attemptID string) *session {
	for _, connection := range manager.sessions {
		if connection.lease.AttemptID == attemptID {
			return connection
		}
	}
	for _, connection := range manager.inbound {
		if connection.lease.AttemptID == attemptID {
			return connection
		}
	}
	return nil
}

// revoke drops a pair's authorization and everything that depended on it.
//
// Extracted from the signal loop because it is the one place a gateway is
// deliberately destroyed rather than kept for the next reconnect, and that
// decision has to be testable on its own.
func (manager *Manager) revoke(pairID string) {
	manager.mu.Lock()
	pin, pinned := manager.pins[pairID]
	delete(manager.pins, pairID)
	if pinned {
		// Record the network the way RevokeNetwork does, so a session still being
		// reserved for this pair is closed too instead of outliving its
		// authorization.
		if manager.revokedPairs == nil {
			manager.revokedPairs = make(map[string]string)
		}
		manager.revokedPairs[pairID] = pin.Pair.NetworkID
	}
	endpoint := manager.endpoints[pairID]
	served := manager.inboundEndpoints[pairID]
	delete(manager.endpoints, pairID)
	delete(manager.inboundEndpoints, pairID)
	connection := manager.sessions[pairID]
	answered := manager.inbound[pairID]
	manager.mu.Unlock()
	// Closed outside the lock: a revoked pair must lose its reachable address at
	// once, including when no session was live, and Close reaches into the
	// gateway's own locks.
	if connection != nil {
		connection.cancel()
	}
	if answered != nil {
		answered.cancel()
	}
	if endpoint != nil {
		endpoint.Close()
	}
	if served != nil {
		served.Close()
	}
}

// receive consumes one subscription until it ends.
//
// The subscription is a parameter rather than manager state on purpose: after a
// loss the supervisor installs a new one and starts a new loop, and the old loop
// must drain the old channel instead of reading events that belong to its
// replacement.
func (manager *Manager) receive(active subscription) {
	for event := range active.Events() {
		if event.Type == "attempt" {
			if event.Lease.FromDeviceID != manager.config.Device.DeviceID {
				manager.mu.Lock()
				pairID, ok := manager.pairForRemoteLocked(event.Lease.FromDeviceID, event.Lease.NetworkID)
				manager.mu.Unlock()
				if ok {
					if _, err := manager.start(pairID, event.Lease, nil); err != nil {
						fmt.Fprintf(os.Stderr, "start %s: %v\n", pairID, err)
					}
				} else {
					// A pinned pair is how this device proves it may answer, so a
					// missing pin is why the offer that follows will be dropped.
					// Without this line the failure is invisible on the side that
					// is being connected to.
					fmt.Fprintf(os.Stderr, "attempt %s: %v\n", event.Lease.AttemptID, errors.New("p2p.pair_not_pinned"))
				}
			}
			continue
		}
		if event.Type == "revoked" {
			manager.revoke(event.PairID)
		}
		manager.mu.Lock()
		connection := manager.sessions[event.PairID]
		if connection == nil {
			connection = manager.inbound[event.PairID]
		}
		if event.Type == "signal" {
			connection = manager.sessionByAttemptLocked(event.Signal.AttemptID)
		}
		negotiating := connection != nil && connection.transport != nil
		manager.mu.Unlock()
		if !negotiating {
			// The peer sent a signal this device has no session for. Staying
			// silent here is what made a remote "no answer" impossible to
			// explain from either side; the line costs nothing and names it.
			if event.Type == "signal" {
				fmt.Fprintf(os.Stderr, "signal %s: %v\n", event.Signal.AttemptID, errors.New("p2p.unknown_attempt"))
			}
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
				err = active.Send(ctx, answer)
			}
		} else {
			err = connection.transport.AcceptAnswer(event.Signal)
		}
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "signal %s: %v\n", event.Signal.AttemptID, err)
			connection.cancel()
		}
	}
	// Loss of signaling forbids new negotiation, but active data stays until
	// its existing lease expires; Transport owns this deadline.
}

func (manager *Manager) run(connection *session) {
	// This device dialled the far side when the lease names it as the sender.
	// The direction decides everything downstream: which Endpoint map the
	// long-lived attachment lives in, and whether the stage is announced — an
	// answered session serves the far machine's tab, and announcing its stage
	// here made this machine's own tab show a "ready" it had no address for.
	initiator := connection.lease.FromDeviceID == manager.config.Device.DeviceID
	announce := manager.emit
	if !initiator {
		announce = func(State) {}
	}
	renewed := make(chan struct{})
	go func() { defer close(renewed); manager.renew(connection) }()
	state := State{PairID: connection.PairID, AttemptID: connection.lease.AttemptID, Generation: connection.lease.Generation, Stage: "punching"}
	announce(state)
	defer func() {
		connection.cancel()
		connection.transport.Close()
		<-renewed
		if state.Stage != "failed" {
			state.Stage = "disconnected"
		}
		announce(state)
		manager.end(connection.lease)
		// The endpoint (and its gateway, its port, its URL) is not torn down here:
		// this session ending does not mean the pair stopped being pinned. Only
		// revocation or Manager.Close ever calls endpoint.Close; a plain drop is
		// left attached to nothing until the next reconnect calls Establish again
		// and replaces the session inside it.
		connection.mu.Lock()
		endpoint := connection.endpoint
		connection.mu.Unlock()
		if endpoint != nil {
			endpoint.Detach()
		}
		manager.finish(state.PairID, connection)
	}()
	deadline, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	err := connection.transport.WaitReady(deadline)
	cancel()
	var gateway *runtimebridge.Gateway
	var endpoint *runtimebridge.Endpoint
	var mux *peer.Mux
	var binding runtimebridge.Binding
	if err == nil {
		state.Path, err = connection.transport.Path()
	}
	if err == nil {
		state.Stage = "starting-runtime"
		announce(state)
		// The browsed runtime and the served one are separate attachments, so the
		// direction picks the map: a dialled session's Endpoint carries the
		// browser gateway this machine's tab loads, an answered session's carries
		// the listener that serves the far machine. Sharing one made whichever
		// direction connected second reuse the other's attachment.
		attachments := manager.endpoints
		if !initiator {
			attachments = manager.inboundEndpoints
		}
		manager.mu.Lock()
		existing := attachments[connection.PairID]
		manager.mu.Unlock()
		// The session context ends with this attempt; the gateway must outlive it,
		// so its listener is owned by the manager instead. Attaching the gateway to
		// connection.ctx would close its port the moment this session ended, making
		// the URL change on every reconnect — the thing a stable URL must not do.
		gateway, endpoint, mux, binding, err = runtimebridge.Establish(connection.ctx, manager.ctx, connection.transport, connection.lease, initiator, manager.runtimeOwner(connection), existing)
		if err == nil {
			connection.mu.Lock()
			connection.mux, connection.endpoint = mux, endpoint
			connection.mu.Unlock()
			manager.mu.Lock()
			attachments[connection.PairID] = endpoint
			manager.mu.Unlock()
		}
	}
	if mux != nil {
		defer mux.Close()
	}
	// The URL is the endpoint's own address, not the binding's: binding.URL is the
	// peer's loopback address and means nothing on this machine. Only the first
	// Establish creates the gateway; every later one replaces the session inside
	// the same one, so the address is already recorded there.
	var readyURL string
	if err == nil {
		if gateway != nil {
			readyURL = gateway.URL
		} else if endpoint != nil {
			readyURL = endpoint.LocalURL()
		}
	}
	if err == nil && readyURL != "" {
		err = runtimebridge.Probe(connection.ctx, readyURL)
	}
	if err == nil && connection.ctx.Err() != nil {
		err = errors.New("p2p.connection_cancelled")
	}
	state.RuntimeGeneration = binding.Generation
	connection.mu.Lock()
	connection.err = err
	if err == nil {
		state.Stage = "ready"
		connection.result = Connected{State: state, URL: readyURL}
	} else {
		// The runtime is only attempted once the direct path is ready, so a
		// failure that never reached that stage is a transport failure. No relay
		// is offered, so that case is reported as "no direct path" rather than as
		// a runtime problem: the two need different user action.
		transportReady := state.Stage == "starting-runtime"
		state.Stage = "failed"
		state.Error = namedRefusal(err, transportReady)
		connection.refusal = state.Error
	}
	connection.mu.Unlock()
	close(connection.ready)
	announce(state)
	if err != nil {
		return
	}
	select {
	case <-connection.ctx.Done():
	case <-connection.transport.Done():
	case <-endpoint.Done():
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

// renewRefusal reports a renewal failure that ends the session. A refusal is a
// typed authorization or scope rejection; anything else (server restart, the
// store aborting mid-request, a dropped coordinator) is transient and retried
// until the local lease timer ends the session in the ordinary path.
func renewRefusal(err error) bool {
	switch err.Error() {
	case "p2p.pair_unauthorized", "p2p.device_unauthorized", "p2p.lease_scope_mismatch", "p2p.identity_mismatch":
		return true
	default:
		return false
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
			if err != nil && renewRefusal(err) {
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
	if !exists {
		// A pair with only an answered session still carries a live transport,
		// and the remote operations below are asked over whichever session is
		// connected, in either direction.
		connection, exists = manager.inbound[pairID]
	}
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
