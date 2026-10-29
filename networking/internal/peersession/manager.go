// Package peersession composes the real coordinator, direct transport and DSH
// gateway. It has no filesystem, shell, test endpoint or credential persistence.
package peersession

import (
	"context"
	"crypto/ed25519"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/pion/stun/v3"
)

type Config struct {
	Endpoints  controlplane.Endpoints
	Authority  controlplane.Identity
	Device     controlplane.Device
	PrivateKey ed25519.PrivateKey
	// Roots provides the authorised directory listing this machine exposes to a
	// connected peer. When nil the directory service is disabled — the peer sees
	// no roots and the remote workspace browser shows "no authorised directories".
	Roots runtimebridge.RootProvider
	// ResumeOwner returns only the currently running binding. It must never
	// launch a runtime; an absent callback explicitly refuses safe recovery.
	ResumeOwner    runtimebridge.RuntimeOwner
	CoreInstanceID string
	Wake           func(string)
	// PeerRegistration runs after a valid coordinator membership event has been
	// applied to the local peer manager. It must schedule work rather than block
	// the signalling receive loop.
	PeerRegistration func(protocol.PeerRegistration)
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
	subscribe       subscribeFunc
	signals         *signaling
	reconnectMu     sync.Mutex
	config          Config
	accountUserID   string
	owner           runtimebridge.RuntimeOwner
	rootProvider    runtimebridge.RootProvider
	emit            func(State)
	emitMu          sync.Mutex
	mu              sync.Mutex
	pins            map[string]controlplane.PairIdentity
	workbenches     map[string]bool
	generations     map[string]uint64
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
	inbound              map[string]*session
	candidates           map[string]*session
	manualWaiters        map[string]*manualCandidateWait
	inboundCandidates    map[string]*session
	inboundAdmissions    map[string]*inboundAdmission
	inboundAdmissionWait sync.WaitGroup
	retiring             map[*session]struct{}
	peerCores            map[string]string
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
	candidatesActive bool
	endJobs          map[string]*endCleanup
	endWait          sync.WaitGroup
	turnCreds        controlplane.TurnCredentials
	turnExpiresAt    time.Time
	turnRefresh      *turnCredentialRefresh
}

type turnCredentialRefresh struct {
	done  chan struct{}
	creds controlplane.TurnCredentials
	err   error
}
type session struct {
	PairID           string
	requestWorkbench bool
	resumeWorkbench  bool
	lease            protocol.Lease
	transport        *peer.Transport
	ctx              context.Context
	cancel           context.CancelFunc
	ready            chan struct{}
	done             chan struct{}
	mu               sync.Mutex
	controlMu        sync.Mutex
	result           Connected
	err              error
	workbenchRefusal string
	// refusal is the named code for a failed attempt, so a caller that returns
	// the failure to the shell does not hand it the raw transport sentence.
	refusal string
	// finishOnce makes retiring a session idempotent; see Manager.finish.
	finishOnce              sync.Once
	mux                     *peer.Mux
	endpoint                *runtimebridge.Endpoint
	diagnostic              sessionDiagnosticState
	ticket                  *protocol.CandidateTicket
	prepare                 *protocol.PrepareCandidate
	predecessor             *session
	predecessorWindow       uint64
	predecessorWasSuspended bool
	commitDispatched        bool
	graceOwner              *candidateGraceOwner
	committedObserved       chan struct{}
	committedOnce           sync.Once
	promoted                bool
	remoteReplaced          bool
	scopeRetired            bool
	changed                 chan struct{}
	cancelRequested         chan struct{}
	cancelOnce              sync.Once
	readyOnce               sync.Once
	stagedGateway           *runtimebridge.Gateway
	stagedEndpoint          *runtimebridge.Endpoint
	signalInbox             chan protocol.Signal
	signalDone              chan struct{}
}

func newSession(parent context.Context) *session {
	ctx, cancel := context.WithCancel(parent)
	return &session{ctx: ctx, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), changed: make(chan struct{}, 1), cancelRequested: make(chan struct{}), committedObserved: make(chan struct{}), signalInbox: make(chan protocol.Signal, 1)}
}

func New(ctx context.Context, client *controlplane.Client, config Config, pins []controlplane.PairIdentity, owner runtimebridge.RuntimeOwner, emit func(State)) (*Manager, error) {
	if len(pins) != 0 {
		return nil, errors.New("p2p.invalid_request")
	}
	if client == nil || owner == nil || emit == nil || !protocol.ValidNonce(config.CoreInstanceID) {
		return nil, errors.New("p2p.helper_configuration_required")
	}
	child, cancel := context.WithCancel(ctx)
	manager := &Manager{ctx: child, cancel: cancel, client: client, config: config, owner: owner, rootProvider: config.Roots, emit: emit, pins: make(map[string]controlplane.PairIdentity), sessions: make(map[string]*session), inbound: make(map[string]*session), endpoints: make(map[string]*runtimebridge.Endpoint), inboundEndpoints: make(map[string]*runtimebridge.Endpoint)}
	manager.candidates, manager.inboundCandidates, manager.peerCores = make(map[string]*session), make(map[string]*session), make(map[string]string)
	manager.accountUserID = client.Account()
	manager.subscribe = func(ctx context.Context, deviceID string) (subscription, error) {
		manager.mu.Lock()
		active := manager.candidatesActive
		manager.mu.Unlock()
		if !active {
			return client.SubscribeControlReadOnly(ctx, deviceID, config.CoreInstanceID)
		}
		return client.SubscribeControl(ctx, deviceID, config.CoreInstanceID)
	}
	_, err := newSignalingInstalled(child, manager.subscribe, config.Device.DeviceID, manager.receive, func(signals *signaling) error {
		manager.mu.Lock()
		manager.signals = signals
		manager.mu.Unlock()
		return nil
	})
	if err != nil {
		cancel()
		return nil, err
	}
	return manager, nil
}

func (manager *Manager) Pin(pin controlplane.PairIdentity) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := manager.pinLocked(pin); err != nil {
		return err
	}
	manager.cancelChangedAdmissionLocked(pin.Pair.PairID)
	manager.cancelChangedManualWaitLocked(pin.Pair.PairID)
	return nil
}

func (manager *Manager) pinLocked(pin controlplane.PairIdentity) error {
	if !protocol.ValidID(pin.Pair.NetworkID) || !protocol.ValidID(pin.Initiator.DeviceID) || !protocol.ValidID(pin.Target.DeviceID) || pin.Pair.Initiator != pin.Initiator.DeviceID || pin.Pair.Target != pin.Target.DeviceID || pin.Pair.Initiator == pin.Pair.Target {
		return errors.New("p2p.identity_mismatch")
	}
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	if !protocol.ValidID(pin.Pair.PairID) || pin.Pair.State != "active" || pin.Pair.Revision == 0 || local.DeviceID != manager.config.Device.DeviceID || !protocol.ValidID(local.UserID) || len(local.PublicKey) != ed25519.PublicKeySize || !ed25519.PublicKey(local.PublicKey).Equal(ed25519.PublicKey(manager.config.Device.PublicKey)) || remote.UserID != local.UserID || len(remote.PublicKey) != 32 {
		return errors.New("p2p.identity_mismatch")
	}
	if manager.closed {
		return errors.New("p2p.helper_unavailable")
	}
	if local.UserID != manager.accountUserID {
		return errors.New("p2p.identity_mismatch")
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

// targetDevice returns the far device identity of a pinned pair, normalizing
// the pair so the local device is the initiator or the target side.
const turnCredentialRefreshLead = 5 * time.Minute

// turnEndpoints returns fresh device-scoped TURN relay credentials. The REST
// username carries its Unix expiry, so a successful response is cached only
// until the refresh window and a failed response is never retained. Concurrent
// callers share the same coordinator request but a later attempt may retry it.
func (manager *Manager) turnEndpoints(ctx context.Context) (controlplane.TurnCredentials, error) {
	manager.mu.Lock()
	if manager.turnExpiresAt.After(time.Now().Add(turnCredentialRefreshLead)) {
		creds := cloneTurnCredentials(manager.turnCreds)
		manager.mu.Unlock()
		return creds, nil
	}
	if refresh := manager.turnRefresh; refresh != nil {
		manager.mu.Unlock()
		select {
		case <-ctx.Done():
			return controlplane.TurnCredentials{}, ctx.Err()
		case <-refresh.done:
			return cloneTurnCredentials(refresh.creds), refresh.err
		}
	}
	refresh := &turnCredentialRefresh{done: make(chan struct{})}
	manager.turnRefresh = refresh
	manager.mu.Unlock()
	// Fetch outside the mutex: the coordinator call may be slow or fail, and
	// holding manager.mu across it would block every other session path.
	creds, err := manager.client.TurnCredentials(ctx)
	var expiresAt time.Time
	if err == nil {
		expiresAt, err = turnCredentialExpiry(creds.Username, manager.config.Device.DeviceID, time.Now())
	}
	if err == nil {
		err = validateTurnCredentials(creds)
	}
	manager.mu.Lock()
	if err == nil {
		manager.turnCreds = cloneTurnCredentials(creds)
		manager.turnExpiresAt = expiresAt
	}
	refresh.creds = cloneTurnCredentials(creds)
	refresh.err = err
	manager.turnRefresh = nil
	close(refresh.done)
	manager.mu.Unlock()
	return cloneTurnCredentials(creds), err
}

func validateTurnCredentials(creds controlplane.TurnCredentials) error {
	if len(creds.URLs) == 0 || creds.Credential == "" || strings.ContainsAny(creds.Credential, " \t\r\n") {
		return errors.New("p2p.invalid_server_response")
	}
	for _, address := range creds.URLs {
		uri, err := stun.ParseURI(address)
		if err != nil || (uri.Scheme != stun.SchemeTypeTURN && uri.Scheme != stun.SchemeTypeTURNS) {
			return errors.New("p2p.invalid_server_response")
		}
	}
	return nil
}

func turnCredentialExpiry(username, deviceID string, now time.Time) (time.Time, error) {
	expires, subject, found := strings.Cut(username, ":")
	seconds, err := strconv.ParseInt(expires, 10, 64)
	if !found || err != nil || seconds <= 0 || subject != deviceID || !protocol.ValidID(subject) {
		return time.Time{}, errors.New("p2p.invalid_server_response")
	}
	expiresAt := time.Unix(seconds, 0)
	if !expiresAt.After(now.Add(turnCredentialRefreshLead)) {
		return time.Time{}, errors.New("p2p.invalid_server_response")
	}
	return expiresAt, nil
}

func cloneTurnCredentials(creds controlplane.TurnCredentials) controlplane.TurnCredentials {
	creds.URLs = append([]string(nil), creds.URLs...)
	return creds
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
	for _, slots := range []map[string]*session{manager.candidates, manager.inboundCandidates} {
		for _, connection := range slots {
			if connection.ticket != nil && connection.ticket.Lease.AttemptID == attemptID {
				return connection
			}
		}
	}
	for _, admission := range manager.inboundAdmissions {
		if admission.connection.lease.AttemptID == attemptID {
			return admission.connection
		}
	}
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

// receive consumes one subscription until it ends.
//
// The subscription is a parameter rather than manager state on purpose: after a
// loss the supervisor installs a new one and starts a new loop, and the old loop
// must drain the old channel instead of reading events that belong to its
// replacement.
func (manager *Manager) receive(active subscription) {
	defer manager.finishInboundSubscription(active)
	for event := range active.Events() {
		manager.receiveControl(active, event)
	}
}

// Record the binding before exposing it to the authenticated peer. Invalidation
// also cancels incoming sessions whose owner request has not completed yet.
func (manager *Manager) runtimeOwner(connection *session) runtimebridge.RuntimeOwner {
	return manager.guardedRuntimeOwner(connection, manager.owner)
}

func (manager *Manager) runtimeResumeOwner(connection *session) runtimebridge.RuntimeOwner {
	if manager.config.ResumeOwner == nil {
		return nil
	}
	return manager.guardedRuntimeOwner(connection, manager.config.ResumeOwner)
}

func (manager *Manager) guardedRuntimeOwner(connection *session, owner runtimebridge.RuntimeOwner) runtimebridge.RuntimeOwner {
	return func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		binding, err := owner(ctx, pairID)
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
	if candidateAuthorityEnded(err) {
		return true
	}
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
			var lease protocol.Lease
			var err error
			if connection.ticket != nil {
				var action protocol.CandidateAction
				action, err = manager.candidateAction(connection)
				if err == nil {
					lease, err = manager.client.RenewCandidate(connection.ctx, action)
				}
			} else {
				err = errors.New("p2p.protocol_mismatch")
			}
			if err == nil {
				err = connection.transport.UpdateLease(lease)
			}
			connection.recordRenewal(err)
			if err != nil && connection.ctx.Err() == nil {
				manager.logSessionDiagnostic(connection, "lease_renewal_failed", connection.transport.Diagnostics())
			}
			if err != nil && renewRefusal(err) {
				connection.stop("lease_renewal_refused", err)
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
