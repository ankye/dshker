// Package helper owns named operations of the installed peer executable.
package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/ankye/dshker/networking/internal/secret"
)

type Main interface {
	Call(context.Context, string, any) (json.RawMessage, error)
}
type Host struct {
	ctx      context.Context
	mu       sync.Mutex
	main     Main
	accounts map[string]*account
	roots    *x509.CertPool
	// deviceKeys is the machine's own key store, separate from any account's
	// credential: see machineDeviceKey.
	deviceKeys secret.Store
	deviceKey  ed25519.PrivateKey
	// catalog is the store this machine's paired computers are recorded in. It
	// belongs to the core and the pairing half lives here, so the record is written
	// where the pairs are read. See members.go.
	catalog catalogStore
	// generation is the last attempt number this host handed out. See nextGeneration.
	generation uint64
	// reconnect is this machine's single reconnection engine, created on first use.
	// The backoff and the recorded terminal refusals are per-machine state, so a
	// shell-driven pass and the daemon's own sweep must share one instance.
	reconnect *autoconnect.Engine
	closed    bool
}
type account struct {
	mu        sync.Mutex
	base      *controlplane.Client
	client    *controlplane.Client
	identity  controlplane.Identity
	endpoints controlplane.Endpoints
	device    controlplane.Device
	manager   *peersession.Manager
	// host is the process this account belongs to: the directory announces its
	// changes through the host's parent channel, and the host's lifetime is the
	// one the maintenance loop follows.
	host *Host
	// stages is the latest stage announced per pair. The session manager reports
	// every transition through the emit callback below, so recording them here is
	// what lets reconnection ask "is this pair already up?" without inventing a
	// second source of truth or polling the transport.
	stages map[string]string
	// directory is this account's single snapshot of the coordinator's device
	// directory. See directory.go.
	directory directory
	// catalogRevision is the last catalog revision announced for this account, so a
	// pass that found the same pairs does not announce anything.
	catalogRevision string
}
type scopedRequest struct {
	ServiceID string          `json:"serviceId"`
	Data      json.RawMessage `json:"data"`
}

func New(ctx context.Context) *Host   { return &Host{ctx: ctx, accounts: make(map[string]*account)} }
func (host *Host) BindMain(main Main) { host.mu.Lock(); host.main = main; host.mu.Unlock() }

// callMain resolves the current callback owner for every call. An already
// restored peer session must follow a desktop attach/detach; capturing the
// headless callback at restore time would keep sending state and runtime
// requests to the old owner after the UI attaches.
func (host *Host) callMain(ctx context.Context, method string, payload any) (json.RawMessage, error) {
	host.mu.Lock()
	main := host.main
	host.mu.Unlock()
	if main == nil {
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	return main.Call(ctx, method, payload)
}

// SetDeviceKeys names the store this machine's own device key lives in.
//
// It is the same OS-backed store the shell's credentials use, opened from the
// core's data root, but the key it holds is not an account's credential: see
// machineDeviceKey.
func (host *Host) SetDeviceKeys(store secret.Store) {
	host.mu.Lock()
	host.deviceKeys = store
	host.mu.Unlock()
}

// machineDeviceKeyName is the reserved secret holding this machine's device key.
const machineDeviceKeyName = "machine.device-key"

// machineDeviceKey returns this machine's device key, creating it once.
//
// A device identity is a property of the machine, like a hardware address, not
// of an enrollment. Minting a fresh key per enrollment is what made every later
// registration and every re-enrollment a different device: the pair, its pins and
// every catalog row referenced the previous identity, the coordinator's list then
// carried entries naming neither side of either machine, and each side wedged on
// the other's stale identity — the failure this whole pass exists to remove.
// Keeping the key beside the data root also means it survives losing the
// credential record itself, which is the usual way a machine silently became a
// new device.
func (host *Host) machineDeviceKey() (ed25519.PrivateKey, error) {
	host.mu.Lock()
	store := host.deviceKeys
	cached := host.deviceKey
	host.mu.Unlock()
	if len(cached) == ed25519.PrivateKeySize {
		return cached, nil
	}
	if store != nil {
		if value, err := store.Get(machineDeviceKeyName); err == nil {
			// A wrong-sized value is a corrupt entry, not an identity: replace it
			// rather than hand out a key that cannot sign.
			if len(value) == ed25519.PrivateKeySize &&
				bytes.Equal(value, ed25519.NewKeyFromSeed(ed25519.PrivateKey(value).Seed())) {
				key := ed25519.PrivateKey(append([]byte(nil), value...))
				host.mu.Lock()
				host.deviceKey = key
				host.mu.Unlock()
				return key, nil
			}
		} else if !errors.Is(err, secret.ErrMissing) {
			return nil, errors.New("p2p.secret_unavailable")
		}
	}
	key, _, err := controlplane.NewDeviceKey()
	if err != nil {
		return nil, err
	}
	if store != nil {
		if err := store.Set(machineDeviceKeyName, key); err != nil {
			// Persisting is what makes the identity survive the next enrollment;
			// answering with an unpersisted key would reintroduce the churn
			// silently, so the caller is told instead.
			return nil, errors.New("p2p.secret_write_failed")
		}
	}
	host.mu.Lock()
	host.deviceKey = key
	host.mu.Unlock()
	return key, nil
}

// SetRoots replaces the trust anchors for the coordinator HTTPS connection. A
// nil pool keeps system roots, which is what the shell relies on: it passes no
// anchors, so a machine that does not already trust the server refuses it
// exactly as documented. The pool is however the caller built it, and it never
// disables verification.
func (host *Host) SetRoots(roots *x509.CertPool) {
	host.mu.Lock()
	host.roots = roots
	host.mu.Unlock()
}
func (host *Host) Close() {
	host.mu.Lock()
	host.closed = true
	accounts := make([]*account, 0, len(host.accounts))
	for _, value := range host.accounts {
		accounts = append(accounts, value)
	}
	host.mu.Unlock()
	for _, value := range accounts {
		// Extract the manager reference under the lock, then release before calling
		// manager.Close(). The session tear-down calls back into the account (emit
		// → announce), which re-acquires account.mu. Holding it across manager.Close
		// would deadlock: host.Close holds account.mu while waiting for the session
		// to finish, and the session waits for account.mu before it can finish.
		value.mu.Lock()
		manager := value.manager
		value.manager = nil
		client := value.client
		value.client = nil
		base := value.base
		value.base = nil
		value.mu.Unlock()
		if manager != nil {
			manager.Close()
		}
		if client != nil {
			client.Close()
		}
		// An account can exist without a control-plane client: it is registered
		// under its service id before one is built, and a configure that failed part
		// way leaves exactly that. The two references above are already guarded;
		// this one was not, so shutting down in that window panicked on the path
		// whose whole job is to release the process's resources.
		if base != nil {
			base.Close()
		}
	}
}

func (host *Host) Handle(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	if ctx.Err() != nil {
		return nil, errors.New("p2p.request_cancelled")
	}
	host.mu.Lock()
	closedAtAdmission := host.closed
	host.mu.Unlock()
	if closedAtAdmission {
		return nil, errors.New("p2p.helper_unavailable")
	}
	if method == "service.configure" {
		return host.configure(ctx, payload)
	}
	if method == "device.createKey" {
		var empty struct{}
		if protocol.DecodeExact(payload, &empty) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		key, err := host.machineDeviceKey()
		if err != nil {
			return nil, err
		}
		csr, err := controlplane.DeviceCSR(key)
		return struct {
			PrivateKey []byte `json:"privateKey"`
			CSR        string `json:"csr"`
		}{key, csr}, err
	}
	if method == "device.createCSR" {
		var request struct {
			PrivateKey []byte `json:"privateKey"`
		}
		if protocol.DecodeExact(payload, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		defer clear(request.PrivateKey)
		csr, err := controlplane.DeviceCSR(request.PrivateKey)
		return struct {
			CSR string `json:"csr"`
		}{csr}, err
	}
	var request scopedRequest
	if protocol.DecodeExact(payload, &request) != nil {
		return nil, errors.New("p2p.invalid_request")
	}
	host.mu.Lock()
	account := host.accounts[request.ServiceID]
	closed := host.closed
	host.mu.Unlock()
	if account == nil || closed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	if method == "peer.autoconnect_reconcile" || method == "peer.autoconnect_retry_now" ||
		method == "peer.autoconnect_clear_refusals" {
		// The coordinator subscription is owned by the restored account, not by
		// the pair retry engine. Reconcile is also the daemon's periodic liveness
		// pass, so repair a displaced/closed signal socket here before asking the
		// engine to reconnect pairs. A healthy socket is left untouched.
		if method == "peer.autoconnect_reconcile" || method == "peer.autoconnect_retry_now" {
			account.mu.Lock()
			manager := account.manager
			account.mu.Unlock()
			if manager != nil {
				if err := manager.ReconnectSignals(ctx); err != nil {
					return nil, err
				}
			}
		}
		return host.autoConnectOperation(ctx, method)
	}
	if method == "peer.connect" || method == "peer.disconnect" || method == "runtime.invalidate" || method == "network.invalidate" || method == "remote.roots" || method == "remote.directory" {
		return account.connection(ctx, method, request.Data)
	}
	// A read of the maintained directory never waits for account work: the
	// snapshot is a value the shell renders while the next read is in flight.
	if method == "directory.inspect" || method == "directory.refresh" {
		return account.directoryOperation(ctx, method, request.Data)
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	if method == "device.restore" {
		return host.restore(ctx, account, request.Data)
	}
	return host.manage(ctx, account, method, request.Data)
}

// manage answers one account operation and keeps the maintained directory in step
// with it.
//
// Every operation that names a user session carries its token, which is how the
// core learns which session this account is being used with: the first such call
// after a restart — the shell's own session restore reads the account — is enough
// to bring the directory up to date and announce it, with no separate handshake
// and no page needing to be opened first.
func (host *Host) manage(ctx context.Context, account *account, method string, data json.RawMessage) (any, error) {
	var probe struct {
		Token string `json:"token"`
	}
	if protocol.DecodeExact(data, &probe) == nil && account.rememberToken(probe.Token) {
		account.refreshAfterWrite()
	}
	result, err := account.management(ctx, method, data)
	if err != nil {
		return result, err
	}
	// Report presence for the account actually in use.
	//
	// Presence is recorded per (device, account) pair and the coordinator authorizes
	// a connection by finding both ends online under one shared account. The account
	// the core reports was set once, while restoring the device, from whatever the
	// credential recorded — and never again. Signing in afterwards therefore left the
	// core reporting for the previous account: the machine was genuinely online, the
	// peer asking about it looked under the account it was itself signed in to, found
	// nothing, and every attempt was refused as p2p.peer_offline while both sides
	// displayed as online. Whichever machine signed in first was the one that became
	// unreachable, and restarting it "fixed" it only because a restart restores the
	// persisted session before the device.
	if account.client != nil {
		switch method {
		case "user.login":
			if session, ok := result.(controlplane.UserSession); ok && session.User.UserID != "" {
				account.client.SetAccount(session.User.UserID)
			}
		case "user.current":
			// A restart signs in by restoring its persisted token rather than by
			// logging in again, and this is the call that reads it. Without this the
			// fix above would only hold until the next launch.
			if user, ok := result.(controlplane.User); ok && user.UserID != "" {
				account.client.SetAccount(user.UserID)
			}
		case "user.logout":
			// Signed in nowhere reads as offline, which is the truth: an account that
			// is no longer signed in must not keep this machine reachable.
			account.client.SetAccount("")
		}
	}
	if method == "user.logout" {
		account.forgetToken()
		account.host.announceDirectory(account.identity.ServiceID, account.snapshot(account.identity.ServiceID).Revision)
		return result, nil
	}
	if directoryChangesOn(method) {
		account.refreshAfterWrite()
	}
	if catalogChangesOn(method) {
		account.refreshCatalogAfterWrite()
	}
	return result, nil
}

// directoryChangesOn reports whether a successful operation can change who is in
// the directory: a binding, a membership, or a network of its own.
func directoryChangesOn(method string) bool {
	switch method {
	case "devices.bind", "devices.unbind", "network.leave", "network.join",
		"networks.create", "networks.delete", "pairs.adopt":
		return true
	}
	return false
}

// catalogChangesOn reports whether a successful operation can change which pairs
// the coordinator authorizes. Leaving a network invalidates its pairs in the same
// transaction, and an approval or a revocation changes one directly, so the
// recorded computers are re-read after those rather than waiting for the next
// maintenance interval to notice.
func catalogChangesOn(method string) bool {
	switch method {
	case "devices.bind", "devices.unbind", "network.leave", "network.join",
		"networks.create", "networks.delete", "networks.deletePair",
		"pairs.adopt", "pairs.action", "pairs.invite":
		return true
	}
	return false
}

// directoryOperation answers the two directory methods the shell calls directly.
func (account *account) directoryOperation(ctx context.Context, method string, data json.RawMessage) (any, error) {
	var empty struct{}
	if protocol.DecodeExact(data, &empty) != nil {
		return nil, errors.New("p2p.invalid_request")
	}
	if method == "directory.refresh" {
		return account.refreshDirectory(ctx)
	}
	return account.snapshot(account.identity.ServiceID), nil
}

func (host *Host) configure(ctx context.Context, payload json.RawMessage) (any, error) {
	var request struct {
		Endpoints controlplane.Endpoints `json:"endpoints"`
		PinnedKey []byte                 `json:"pinnedKey"`
		// The launcher owns its version string, so it is supplied here rather
		// than guessed by the helper. Absent telemetry reports nothing.
		Telemetry controlplane.Telemetry `json:"telemetry"`
	}
	if protocol.DecodeExact(payload, &request) != nil || (len(request.PinnedKey) != 0 && len(request.PinnedKey) != 32) {
		return nil, errors.New("p2p.invalid_request")
	}
	host.mu.Lock()
	roots := host.roots
	host.mu.Unlock()
	base, err := controlplane.New(request.Endpoints, roots)
	if err != nil {
		return nil, err
	}
	base.SetTelemetry(request.Telemetry)
	var pinned ed25519.PublicKey
	if len(request.PinnedKey) > 0 {
		pinned = request.PinnedKey
	}
	identity, err := base.Identity(ctx, pinned)
	if err != nil {
		base.Close()
		return nil, err
	}
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.closed {
		base.Close()
		return nil, errors.New("p2p.helper_unavailable")
	}
	if previous := host.accounts[identity.ServiceID]; previous != nil {
		base.Close()
		if previous.endpoints != request.Endpoints {
			return nil, errors.New("p2p.service_busy")
		}
		return identity, nil
	}
	host.accounts[identity.ServiceID] = &account{base: base, identity: identity, endpoints: request.Endpoints, host: host}
	// The directory is maintained for as long as the account exists: once the
	// shell hands over a user session, the core keeps the list current on its own
	// instead of waiting for a page to be opened. The catalog of paired computers
	// is maintained the same way, from the pairs the same account reads.
	go host.accounts[identity.ServiceID].maintainDirectory(host.ctx)
	go host.accounts[identity.ServiceID].maintainCatalog(host.ctx)
	return identity, nil
}

func (host *Host) restore(ctx context.Context, account *account, data json.RawMessage) (any, error) {
	var request struct {
		Device     controlplane.Device         `json:"device"`
		PrivateKey []byte                      `json:"privateKey"`
		Pins       []controlplane.PairIdentity `json:"pins"`
	}
	if protocol.DecodeExact(data, &request) != nil || account.manager != nil {
		return nil, errors.New("p2p.invalid_device_state")
	}
	client, err := account.base.WithDevice(request.Device, request.PrivateKey, account.identity)
	if err != nil {
		return nil, err
	}
	host.mu.Lock()
	main := host.main
	host.mu.Unlock()
	if main == nil {
		client.Close()
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	owner := func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		data, err := host.callMain(ctx, "runtime.connect", struct {
			ServiceID string `json:"serviceId"`
			PairID    string `json:"pairId"`
		}{account.identity.ServiceID, pairID})
		var binding runtimebridge.Binding
		if err == nil {
			err = protocol.DecodeExact(data, &binding)
		}
		return binding, err
	}
	roots := func(ctx context.Context) ([]runtimebridge.Root, error) {
		data, err := host.callMain(ctx, "runtime.roots", struct {
			ServiceID string `json:"serviceId"`
		}{account.identity.ServiceID})
		if err != nil {
			return nil, err
		}
		var result struct {
			Roots []runtimebridge.Root `json:"roots"`
		}
		if err := protocol.DecodeExact(data, &result); err != nil {
			return nil, err
		}
		return result.Roots, nil
	}
	emit := func(state peersession.State) {
		// Record before announcing: a reconnection pass that runs between the two
		// must see the new stage, not the one it replaced.
		account.mu.Lock()
		if account.stages == nil {
			account.stages = make(map[string]string)
		}
		account.stages[state.PairID] = state.Stage
		account.mu.Unlock()
		ctx, cancel := context.WithTimeout(host.ctx, 5*time.Second)
		defer cancel()
		_, _ = host.callMain(ctx, "peer.state", struct {
			ServiceID string            `json:"serviceId"`
			State     peersession.State `json:"state"`
		}{account.identity.ServiceID, state})
	}
	client.SetAccount(request.Device.UserID)
	manager, err := peersession.New(host.ctx, client, peersession.Config{Endpoints: account.endpoints, Authority: account.identity, Device: request.Device, PrivateKey: request.PrivateKey, Roots: roots}, request.Pins, owner, emit)
	if err != nil {
		client.Close()
		return nil, err
	}
	account.client, account.manager, account.device = client, manager, request.Device
	// Take ownership of the credential this restore carried.
	//
	// The core holds the machine's private key but used to keep nothing that says
	// what that key was enrolled as, so the only complete copy lived in the shell,
	// encrypted with a key only Electron can use. A core with no desktop attached
	// therefore could not act as the device it already had the key for: `dshkerd
	// serve` came up, answered RPC and never reached the coordinator. Recording it
	// here is what converges an existing installation — the shell restores once, as
	// it always did, and from then on the core can restore itself.
	//
	// A store that cannot hold it is logged rather than failing the restore: this
	// session is already usable, and refusing it would turn a machine that works
	// today into one that does not.
	if err := host.SaveCredential(account.identity.ServiceID, request.Device, request.PrivateKey); err != nil {
		log.Printf("[p2p] credential could not be recorded for service %s: %v", account.identity.ServiceID, err)
	}
	// A restored session starts with no pins, and the peer session admits a
	// connection only for a pair it has pinned. The catalog pass is what pins, and
	// answering this call is what the shell takes as "online", so the pass runs
	// before the answer: until it has run, this machine is online and unable to
	// accept a connection, and an attempt in that window is refused with nothing the
	// user could read. It runs with the account lock already held, which is why it
	// is the locked half of the pass.
	if _, err := account.refreshCatalogLocked(ctx); err != nil {
		log.Printf("[p2p] catalog refresh after restore failed: %v", err)
	}
	return struct {
		DeviceID string `json:"deviceId"`
	}{request.Device.DeviceID}, nil
}

func (account *account) connection(ctx context.Context, method string, data json.RawMessage) (any, error) {
	account.mu.Lock()
	manager := account.manager
	account.mu.Unlock()
	if method == "network.invalidate" {
		var request struct {
			NetworkID string `json:"networkId"`
		}
		if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.NetworkID) {
			return nil, errors.New("p2p.invalid_request")
		}
		// A configured account with no device manager owns no local peer authority.
		if manager == nil {
			return struct{}{}, nil
		}
		return struct{}{}, manager.RevokeNetwork(request.NetworkID)
	}
	if manager == nil {
		return nil, errors.New("p2p.device_unregistered")
	}
	if method == "runtime.invalidate" {
		var request struct {
			Generation uint64 `json:"generation"`
		}
		if protocol.DecodeExact(data, &request) != nil || request.Generation == 0 {
			return nil, errors.New("p2p.invalid_request")
		}
		manager.InvalidateRuntime(request.Generation)
		return struct{}{}, nil
	}
	if method == "remote.roots" {
		var request struct {
			PairID string `json:"pairId"`
		}
		if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.PairID) {
			return nil, errors.New("p2p.invalid_request")
		}
		roots, err := manager.RemoteRoots(ctx, request.PairID)
		if err != nil {
			return nil, err
		}
		return struct {
			Roots []runtimebridge.Root `json:"roots"`
		}{roots}, nil
	}
	if method == "remote.directory" {
		var request struct {
			PairID string `json:"pairId"`
			RootID string `json:"rootId"`
			Ref    string `json:"ref"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
		}
		if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.PairID) || request.RootID == "" {
			return nil, errors.New("p2p.invalid_request")
		}
		entries, total, err := manager.RemoteDirectory(ctx, request.PairID, request.RootID, request.Ref, request.Offset, request.Limit)
		if err != nil {
			return nil, err
		}
		return struct {
			Entries []runtimebridge.Entry `json:"entries"`
			Total   int                   `json:"total"`
		}{entries, total}, nil
	}
	if method == "peer.disconnect" {
		var request struct {
			PairID string `json:"pairId"`
		}
		if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.PairID) {
			return nil, errors.New("p2p.invalid_request")
		}
		return struct{}{}, manager.Disconnect(request.PairID)
	}
	var request struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}
	if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.PairID) || request.Generation == 0 {
		return nil, errors.New("p2p.invalid_request")
	}
	// Repair a displaced coordinator subscription before dialing.
	//
	// The signalling supervisor deliberately stands down for good when the
	// coordinator reports that a newer socket for this device exists: reconnecting
	// would kick the live socket off and the two would displace each other forever.
	// The cost is that the subscription stays marked down after the newer socket is
	// itself gone — this process restarting is exactly that case — and every later
	// connect answered p2p.server_unavailable while both machines still looked
	// online, because presence travels a different path than signalling. A restart
	// of the whole Launcher used to be the only exit.
	//
	// The repair existed but was only reachable from the reconciliation methods and
	// from the headless serve loop, so the one action a user actually takes when
	// nothing works — pressing connect — was the single path that never repaired
	// anything. A healthy subscription is left untouched, so this is safe to run on
	// every attempt.
	if err := manager.ReconnectSignals(ctx); err != nil {
		return nil, err
	}
	return manager.Connect(ctx, request.PairID, request.Generation)
}
