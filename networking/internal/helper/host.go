// Package helper owns named operations of the installed peer executable.
package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
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
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	credentialMu sync.Mutex
	main         Main
	accounts     map[string]*account
	roots        *x509.CertPool
	// deviceKeys is the machine's own key store, separate from any account's
	// credential: see machineDeviceKey.
	deviceKeys     secret.Store
	deviceKey      ed25519.PrivateKey
	coreInstanceID string
	// catalog is the store this machine's paired computers are recorded in. It
	// belongs to the core and the pairing half lives here, so the record is written
	// where the pairs are read. See members.go.
	catalog catalogStore
	// generation is the last attempt number this host handed out. See nextGeneration.
	generation uint64
	// reconnect is this machine's single reconnection engine, created on first use.
	// The backoff and the recorded terminal refusals are per-machine state, so a
	// shell-driven pass and the daemon's own sweep must share one instance.
	reconnect              *autoconnect.Engine
	closed                 bool
	removalRevision        uint64
	removedAt              map[string]uint64
	bootstrapMu            sync.Mutex
	bootstraps             map[string]*bootstrapJob
	bootstrapGeneration    map[string]uint64
	bootstrapSessionOwners map[string]*bootstrapSessionOwner
}
type account struct {
	mu                sync.Mutex
	closed            bool
	httpPhase         accountHTTPPhase
	lifetime          context.Context
	cancel            context.CancelFunc
	base              *controlplane.Client
	client            *controlplane.Client
	identity          controlplane.Identity
	endpoints         controlplane.Endpoints
	device            controlplane.Device
	manager           *peersession.Manager
	activationPending error
	activationSource  *authRecoverySource
	authRecoveryJoins []*peersession.AccountRecoveryCompletion
	// host is the process this account belongs to: the directory announces its
	// changes through the host's parent channel, and the host's lifetime is the
	// one the maintenance loop follows.
	host *Host
	// stages is the latest stage announced per pair. The session manager reports
	// every transition through the emit callback below, so recording them here is
	// what lets reconnection ask "is this pair already up?" without inventing a
	// second source of truth or polling the transport.
	stages   map[string]string
	refusals map[string]string
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

type deviceRestoreRequest struct {
	Device        controlplane.Device         `json:"device"`
	PrivateKey    []byte                      `json:"privateKey"`
	Pins          []controlplane.PairIdentity `json:"pins"`
	AccountUserID string                      `json:"accountUserId"`
}

func New(ctx context.Context) *Host {
	child, cancel := context.WithCancel(ctx)
	return &Host{ctx: child, cancel: cancel, accounts: make(map[string]*account), coreInstanceID: protocol.NewNonce()}
}
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
	host.cancel()
	host.mu.Lock()
	host.closed = true
	accounts := make([]*account, 0, len(host.accounts))
	for _, value := range host.accounts {
		accounts = append(accounts, value)
	}
	host.mu.Unlock()
	host.cancelBootstraps("")
	host.mu.Lock()
	reconnect := host.reconnect
	host.mu.Unlock()
	if reconnect != nil {
		reconnect.Close()
	}
	for _, value := range accounts {
		value.close()
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
	// Every operation belongs to both its caller and the core lifetime.
	operation, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(host.ctx, cancel)
	defer stop()
	defer cancel()
	ctx = operation
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
	if (method == "peer.entry" || method == "device.certificate_recovery_scope") && !protocol.ValidID(request.ServiceID) {
		return nil, errors.New("p2p.invalid_request")
	}
	host.mu.Lock()
	account := host.accounts[request.ServiceID]
	closed := host.closed
	host.mu.Unlock()
	if account == nil || closed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	if account.lifetime != nil {
		stopAccount := context.AfterFunc(account.lifetime, cancel)
		defer stopAccount()
	}
	if method == "user.current" || method == "device.restore" {
		if err := host.admitSelectedSessionRead(request.ServiceID, method, request.Data); err != nil {
			return nil, err
		}
	}
	if method == "user.logout" {
		admission, err := host.admitLogoutBootstrap(request.ServiceID, request.Data)
		if err != nil {
			return nil, err
		}
		if err := host.cancelLogoutBootstrap(admission); err != nil {
			return nil, err
		}
	} else if method == "user.login" || method == "user.register" || method == "user.current" || method == "device.restore" {
		// A bootstrap may be waiting for account.mu: cancel and join before
		// taking that lock, never from an account-owned callback.
		host.cancelBootstraps(request.ServiceID)
	}
	host.bootstrapMu.Lock()
	operationGeneration := host.bootstrapGeneration[request.ServiceID]
	host.bootstrapMu.Unlock()
	if method == "device.restore" || method == "user.current" || method == "user.login" || method == "user.register" {
		ctx = withBootstrapLocalFence(ctx, request.ServiceID, operationGeneration, nil, false)
	}
	var expectedSession persistedAccountSession
	var expectedSessionExists bool
	var expectedSessionErr error
	if method == "device.restore" || method == "user.current" {
		expectedSession, expectedSessionExists, expectedSessionErr = host.readAccountSession(request.ServiceID)
	}
	if method == "device.restore" || method == "user.current" {
		ctx = host.selectedCallerContext(ctx, account, operationGeneration, expectedSession, expectedSessionExists, expectedSessionErr)
	}
	if method == "peer.entry" {
		return account.entry(request.Data)
	}
	if method == "peer.autoconnect_reconcile" || method == "peer.autoconnect_retry_now" {
		// The coordinator subscription is owned by the restored account, not by
		// the pair retry engine. Reconcile is also the daemon's periodic liveness
		// pass, so repair a displaced/closed signal socket here before asking the
		// engine to reconnect pairs. A healthy socket is left untouched.
		if err := account.maintainCertificate(ctx); err != nil {
			return nil, err
		}
		account.mu.Lock()
		manager := account.manager
		account.mu.Unlock()
		if manager != nil {
			if err := manager.ReconnectSignals(ctx); err != nil {
				return nil, err
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
	if account.closed {
		account.mu.Unlock()
		return nil, errors.New("p2p.service_unconfigured")
	}
	var result any
	var err error
	if method == "device.restore" {
		result, err = host.restore(ctx, account, request.Data)
	} else if method == "device.certificate" {
		result, err = host.certificate(ctx, account, request.Data)
	} else if method == "device.certificate_recovery_scope" {
		if account.identity.ServiceID != request.ServiceID {
			err = errors.New("p2p.identity_mismatch")
		} else {
			result, err = account.certificateRecoveryScope(ctx, request.Data)
		}
	} else {
		result, err = host.manage(ctx, account, method, request.Data)
	}
	var retry *bootstrapJob
	if bootstrapTransient(err) && ctx.Err() == nil && (method == "device.restore" || method == "user.login" || method == "user.register" || method == "user.current") {
		captured, captureErr := host.captureBootstrap(request.ServiceID)
		if captureErr == nil {
			matching := captured.generation == operationGeneration
			if method == "device.restore" || method == "user.current" {
				matching = matching && expectedSessionErr == nil && captured.hasSession == expectedSessionExists && captured.session == expectedSession
			}
			if matching {
				retry = captured
			} else {
				clear(captured.credential.PrivateKey)
			}
		}
	}
	completions := account.authRecoveryJoins
	account.authRecoveryJoins = nil
	pendingAuthentication := account.activationPending != nil && (method == "user.login" || method == "user.register" || method == "user.current" || method == "user.logout")
	account.mu.Unlock()
	// Old receive/emit callbacks can wait for account.mu. This exact operation
	// owns their join after unlocking, including cancelled/error paths.
	for _, completion := range completions {
		completion.Wait()
	}
	if pendingAuthentication && ctx.Err() != nil && err == nil {
		err = errors.New("p2p.request_cancelled")
		result = nil
	}
	if retry != nil {
		host.scheduleCapturedBootstrap(retry)
	}
	return result, err
}

// manage answers one account operation and keeps the maintained directory in step
// with it.
//
// Only a confirmed durable login/current session may publish directory authority.
// A token on an unrelated read is not a login or permission to switch accounts.
func (host *Host) manage(ctx context.Context, account *account, method string, data json.RawMessage) (any, error) {
	if account.closed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	if method == "user.logout" {
		return account.logout(ctx, data)
	}
	if directoryChangesOn(method) || catalogChangesOn(method) {
		// These writes schedule selected-account authority work. Capture before
		// their first HTTP; ordinary explicit Bearer data reads remain unchanged.
		scope, err := account.selectedSessionScopeLocked(ctx)
		if err != nil {
			return nil, err
		}
		ctx = scope.Context(ctx)
	}
	var probe struct {
		Token string `json:"token"`
	}
	if method == "user.current" {
		if protocol.DecodeExact(data, &probe) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		if err := account.confirmCurrentSession(probe.Token); err != nil {
			return nil, err
		}
		if err := account.checkCallerSessionLocked(ctx); err != nil {
			return nil, err
		}
		scope, err := account.selectedSessionScopeLocked(ctx)
		if err != nil {
			return nil, err
		}
		ctx = scope.Context(ctx)
	}
	authentication := method == "user.login" || method == "user.register" || method == "user.current"
	if authentication {
		if _, err := account.authRecoveryRequiredLocked(ctx); err != nil {
			return nil, err
		}
	}
	result, err := account.management(ctx, method, data)
	if err != nil {
		return result, err
	}
	if method == "user.login" || method == "user.register" {
		session, ok := result.(controlplane.UserSession)
		if !ok {
			return nil, errors.New("p2p.invalid_user_session")
		}
		if err := account.confirmLogin(ctx, session); err != nil {
			return nil, err
		}
		ctx, err = account.confirmedSessionContextLocked(ctx, session)
		if err != nil {
			return nil, err
		}
	}
	if method == "user.current" {
		user, ok := result.(controlplane.User)
		if !ok || !protocol.ValidID(user.UserID) || user.Username == "" {
			return nil, errors.New("p2p.invalid_user_session")
		}
		if err := account.confirmCurrentSession(probe.Token); err != nil {
			return nil, err
		}
		account.rememberToken(probe.Token)
	}
	if authentication {
		if err := checkBootstrapContext(ctx); err != nil {
			return nil, err
		}
		session, exists, err := host.readAccountSession(account.identity.ServiceID)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, errors.New("p2p.user_login_required")
		}
		if err := host.checkSessionRevocation(account.identity.ServiceID, session); err != nil {
			return nil, err
		}
	}
	// Authentication and its durable confirmation have really completed. Only
	// this fresh identity/expiry admission may choose pending versus activation;
	// no failed WSS/catalog operation is caught and converted into auth success.
	recoveryPending := false
	if authentication {
		var err error
		recoveryPending, err = account.authRecoveryRequiredLocked(ctx)
		if err != nil {
			return nil, err
		}
	}
	if recoveryPending {
		var userID string
		if method == "user.current" {
			userID = result.(controlplane.User).UserID
		} else {
			userID = result.(controlplane.UserSession).User.UserID
		}
		if err := account.deferAccountActivationLocked(ctx, userID); err != nil {
			return nil, err
		}
		if err := checkBootstrapContext(ctx); err != nil {
			return nil, err
		}
		return result, nil
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
		case "user.login", "user.register":
			if session, ok := result.(controlplane.UserSession); ok && session.User.UserID != "" {
				if err := account.reportAccount(ctx, session.User.UserID); err != nil {
					return nil, err
				}
			}
		case "user.current":
			// A restart signs in by restoring its persisted token rather than by
			// logging in again, and this is the call that reads it. Without this the
			// fix above would only hold until the next launch.
			if user, ok := result.(controlplane.User); ok && user.UserID != "" {
				if err := account.reportAccount(ctx, user.UserID); err != nil {
					return nil, err
				}
			}
		}
	}
	if method == "user.login" || method == "user.register" || method == "user.current" {
		if account.client != nil {
			if _, err := account.refreshCatalogLocked(ctx); err != nil {
				return nil, err
			}
		}
		if err := checkBootstrapContext(ctx); err != nil {
			return nil, err
		}
		if err := account.refreshAfterWrite(ctx); err != nil {
			return nil, err
		}
	}
	if directoryChangesOn(method) {
		if err := account.refreshAfterWrite(ctx); err != nil {
			return nil, err
		}
	}
	if catalogChangesOn(method) {
		if err := account.refreshCatalogAfterWrite(ctx); err != nil {
			return nil, err
		}
	}
	if authentication {
		if err := checkBootstrapContext(ctx); err != nil {
			return nil, err
		}
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
	account.mu.Lock()
	defer account.mu.Unlock()
	if account.closed {
		return nil, errors.New("p2p.service_unconfigured")
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
	admittedRevision := host.removalRevision
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
	if host.removedAt[identity.ServiceID] > admittedRevision {
		base.Close()
		return nil, errors.New("p2p.service_unconfigured")
	}
	if previous := host.accounts[identity.ServiceID]; previous != nil {
		base.Close()
		if previous.endpoints != request.Endpoints {
			return nil, errors.New("p2p.service_busy")
		}
		return identity, nil
	}
	lifetime, cancel := context.WithCancel(host.ctx)
	host.accounts[identity.ServiceID] = &account{base: base, httpPhase: accountHTTPSetup, identity: identity, endpoints: request.Endpoints, host: host, cancel: cancel, lifetime: lifetime}
	// The directory is maintained for as long as the account exists: once the
	// shell hands over a user session, the core keeps the list current on its own
	// instead of waiting for a page to be opened. The catalog of paired computers
	// is maintained the same way, from the pairs the same account reads.
	go host.accounts[identity.ServiceID].maintainDirectory(lifetime)
	go host.accounts[identity.ServiceID].maintainCatalog(lifetime)
	go host.accounts[identity.ServiceID].maintainCertificates(lifetime)
	return identity, nil
}

func (host *Host) restore(ctx context.Context, account *account, data json.RawMessage) (any, error) {
	if account.closed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	var request deviceRestoreRequest
	if protocol.DecodeExact(data, &request) != nil {
		return nil, errors.New("p2p.invalid_device_state")
	}
	if request.Pins == nil || len(request.Pins) != 0 {
		return nil, errors.New("p2p.invalid_request")
	}
	defer clear(request.PrivateKey)
	var err error
	ctx, err = account.restoreSessionContextLocked(ctx, request)
	if err != nil {
		return nil, err
	}
	reportedAccount := request.AccountUserID
	if reportedAccount != "" {
		if !protocol.ValidID(reportedAccount) {
			return nil, errors.New("p2p.invalid_request")
		}
		selected, err := account.selectedAccount(ctx)
		if err != nil {
			return nil, err
		}
		if selected != reportedAccount {
			return nil, errors.New("p2p.user_scope_mismatch")
		}
	}
	ctx, device, err := host.prepareRestoreCertificate(ctx, account, request.Device, request.PrivateKey)
	if err != nil {
		return nil, err
	}
	request.Device = device
	if err := certificateContext(ctx); err != nil {
		return nil, err
	}
	if account.manager != nil {
		if !sameDevice(account.device, device) {
			return nil, errors.New("p2p.identity_mismatch")
		}
		if err := account.reportAccount(ctx, reportedAccount); err != nil {
			return nil, err
		}
		// Failed activation can leave this same account's read-only owner closed.
		// Repair it before a fresh scoped identity read needs its registration.
		if !account.manager.CandidatesActive() {
			if err := account.manager.ReconnectSignals(ctx); err != nil {
				return nil, err
			}
		}
		if _, err := account.refreshCatalogLocked(ctx); err != nil {
			return nil, err
		}
		if err := account.finishRestoreLocked(ctx); err != nil {
			return nil, err
		}
		return struct {
			DeviceID string `json:"deviceId"`
		}{device.DeviceID}, nil
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
		return host.runtimeBinding(ctx, "runtime.connect", account.identity.ServiceID, pairID)
	}
	resumeOwner := func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		return host.runtimeBinding(ctx, "runtime.resume", account.identity.ServiceID, pairID)
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
	publication := &restorePublication{host: host, account: account}
	client.SetAccount(reportedAccount)
	manager, err := peersession.New(host.ctx, client, peersession.Config{Endpoints: account.endpoints, Authority: account.identity, Device: request.Device, PrivateKey: append(ed25519.PrivateKey(nil), request.PrivateKey...), Roots: roots, ResumeOwner: resumeOwner, CoreInstanceID: host.coreInstanceID, Wake: func(pairID string) {
		host.AutoConnectEngine().Wake(autoconnect.Intent{ServiceID: account.identity.ServiceID, PairID: pairID})
	}}, request.Pins, owner, publication.emit)
	if err != nil {
		client.Close()
		return nil, err
	}
	if err := certificateContext(ctx); err != nil {
		account.discardRestoreManagerLocked(manager, client)
		return nil, err
	}
	if err := account.publishRestoreStateLocked(ctx, func() error {
		account.client, account.manager, account.device = client, manager, request.Device
		account.httpPhase = accountHTTPDevice
		publication.published.Store(true)
		return nil
	}); err != nil {
		account.discardRestoreManagerLocked(manager, client)
		return nil, err
	}
	// A restored session starts with no pins, and the peer session admits a
	// connection only for a pair it has pinned. The catalog pass is what pins, and
	// answering this call is what the shell takes as "online", so the pass runs
	// before the answer: until it has run, this machine is online and unable to
	// accept a connection, and an attempt in that window is refused with nothing the
	// user could read. It runs with the account lock already held, which is why it
	// is the locked half of the pass.
	if _, err := account.refreshCatalogLocked(ctx); err != nil {
		return nil, err
	}
	if err := account.finishRestoreLocked(ctx); err != nil {
		return nil, err
	}
	return struct {
		DeviceID string `json:"deviceId"`
	}{request.Device.DeviceID}, nil
}

type restorePublication struct {
	host      *Host
	account   *account
	published atomic.Bool
}

func (publication *restorePublication) emit(state peersession.State) {
	// Until publication this external Host callback must not wait for account.mu.
	// Internal WSS registration/event processing remains owned by the Manager.
	if !publication.published.Load() {
		return
	}
	account, host := publication.account, publication.host
	account.mu.Lock()
	if account.manager == nil || !account.manager.OwnsState(state) {
		account.mu.Unlock()
		return
	}
	if account.stages == nil {
		account.stages = make(map[string]string)
	}
	if account.refusals == nil {
		account.refusals = make(map[string]string)
	}
	account.stages[state.PairID] = state.Stage
	account.refusals[state.PairID] = state.Error
	account.mu.Unlock()
	ctx, cancel := context.WithTimeout(host.ctx, 5*time.Second)
	defer cancel()
	_, _ = host.callMain(ctx, "peer.state", struct {
		ServiceID string            `json:"serviceId"`
		State     peersession.State `json:"state"`
	}{account.identity.ServiceID, state})
}

func (account *account) connection(ctx context.Context, method string, data json.RawMessage) (any, error) {
	account.mu.Lock()
	if account.closed {
		account.mu.Unlock()
		return nil, errors.New("p2p.service_unconfigured")
	}
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
		PairID           string `json:"pairId"`
		Generation       uint64 `json:"generation"`
		RequestWorkbench bool   `json:"requestWorkbench"`
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
	return manager.Connect(ctx, request.PairID, request.Generation, request.RequestWorkbench)
}
