package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

type certificateRecoveryScope struct {
	User     controlplane.User  `json:"user"`
	Networks []DirectoryNetwork `json:"networks"`
}

type recoveryScopeSource struct {
	credential storedCredential
	session    persistedAccountSession
	removal    uint64
	scope      *selectedSessionScope
}

// This is a named public recovery authorization owner, not an ordinary Bearer
// transport fallback. The caller holds account.mu throughout. An expired bound
// certificate is permitted, but the original credential and durable selected
// session must remain exact after every read. No network is chosen or cached.
func (account *account) certificateRecoveryScope(ctx context.Context, data json.RawMessage) (any, error) {
	var request struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
	}
	if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.DeviceID) || request.Token == "" {
		return nil, errors.New("p2p.invalid_request")
	}
	if err := account.recoveryScopeLifecycle(ctx); err != nil {
		return nil, err
	}
	credential, err := account.host.LoadCredential(account.identity.ServiceID)
	if err != nil {
		return nil, recoveryScopeCredentialError(err)
	}
	defer clear(credential.PrivateKey)
	if credential.DeviceID != request.DeviceID || credential.Endpoints != account.endpoints || !bytes.Equal(credential.ServiceKey, account.identity.PublicKey) ||
		(account.httpPhase == accountHTTPDevice && !sameDevice(account.device, credential.device())) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	if _, err := account.base.ValidateDevice(credential.device(), credential.PrivateKey, account.identity, true); err != nil {
		return nil, err
	}
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("p2p.user_login_required")
	}
	if session.Token != request.Token {
		return nil, errors.New("p2p.user_scope_mismatch")
	}
	scope, err := account.captureSelectedSessionScopeLocked(ctx, session)
	if err != nil {
		return nil, err
	}
	ctx = scope.Context(ctx)
	account.host.mu.Lock()
	removal := account.host.removedAt[account.identity.ServiceID]
	account.host.mu.Unlock()
	source := recoveryScopeSource{credential: credential, session: session, removal: removal, scope: scope}
	if err := account.checkRecoveryScope(ctx, source); err != nil {
		return nil, err
	}
	user, err := account.base.CurrentUser(ctx, session.Token)
	if fence := account.checkRecoveryScope(ctx, source); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	if !protocol.ValidID(user.UserID) || user.Username == "" {
		return nil, errors.New("p2p.invalid_server_response")
	}
	if err := account.checkRecoveryScope(ctx, source); err != nil {
		return nil, err
	}
	networks, err := account.base.Networks(ctx, session.Token)
	if fence := account.checkRecoveryScope(ctx, source); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	if networks == nil {
		return nil, errors.New("p2p.invalid_server_response")
	}
	seen := make(map[string]bool, len(networks))
	for _, network := range networks {
		if !protocol.ValidID(network.NetworkID) || network.UserID != user.UserID || network.Name == "" || network.MaxDevices < 1 || seen[network.NetworkID] {
			return nil, errors.New("p2p.invalid_server_response")
		}
		seen[network.NetworkID] = true
	}
	result := certificateRecoveryScope{User: user, Networks: make([]DirectoryNetwork, 0, len(networks))}
	for _, network := range networks {
		if err := account.checkRecoveryScope(ctx, source); err != nil {
			return nil, err
		}
		devices, err := account.base.NetworkDevices(ctx, session.Token, network.NetworkID)
		if fence := account.checkRecoveryScope(ctx, source); fence != nil {
			return nil, fence
		}
		if err != nil {
			return nil, err
		}
		if !validRecoveryScopeDevices(devices) {
			return nil, errors.New("p2p.invalid_server_response")
		}
		result.Networks = append(result.Networks, DirectoryNetwork{NetworkID: network.NetworkID, UserID: network.UserID, Name: network.Name, MaxDevices: network.MaxDevices, Devices: devices})
	}
	if err := account.checkRecoveryScope(ctx, source); err != nil {
		return nil, err
	}
	var projection any
	if err := scope.Publish(ctx, func() error { projection = result; return nil }); err != nil {
		return nil, err
	}
	return projection, nil
}

func recoveryScopeCredentialError(err error) error {
	if errors.Is(err, secret.ErrMissing) {
		return errors.New("p2p.invalid_device_state")
	}
	return err
}

func (account *account) recoveryScopeLifecycle(ctx context.Context) error {
	if ctx.Err() != nil || account.host.ctx.Err() != nil || (account.lifetime != nil && account.lifetime.Err() != nil) {
		return errors.New("p2p.request_cancelled")
	}
	account.host.mu.Lock()
	current := !account.host.closed && account.host.accounts[account.identity.ServiceID] == account
	account.host.mu.Unlock()
	if !current || account.closed || account.httpPhase == accountHTTPClosed {
		return errors.New("p2p.service_unconfigured")
	}
	if account.base == nil || (account.httpPhase != accountHTTPSetup && account.httpPhase != accountHTTPDevice) {
		return errors.New("p2p.invalid_device_state")
	}
	return nil
}

func (account *account) checkRecoveryScope(ctx context.Context, source recoveryScopeSource) error {
	if err := checkBootstrapContext(source.scope.Context(ctx)); err != nil {
		return err
	}
	if err := account.recoveryScopeLifecycle(ctx); err != nil {
		return err
	}
	account.host.mu.Lock()
	removal := account.host.removedAt[account.identity.ServiceID]
	account.host.mu.Unlock()
	if removal != source.removal {
		return errors.New("p2p.service_unconfigured")
	}
	current, err := account.host.LoadCredential(account.identity.ServiceID)
	if err != nil {
		return recoveryScopeCredentialError(err)
	}
	defer clear(current.PrivateKey)
	if !sameBootstrapDevice(source.credential, current) || source.credential.Version != current.Version || source.credential.UserID != current.UserID || source.credential.Name != current.Name || !bytes.Equal(source.credential.Certificate, current.Certificate) {
		return errors.New("p2p.identity_mismatch")
	}
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return err
	}
	if !exists || session != source.session {
		return errors.New("p2p.user_scope_mismatch")
	}
	if session.ExpiresAt <= time.Now().Unix() {
		return errors.New("p2p.user_session_expired")
	}
	if err := account.recoveryScopeLifecycle(ctx); err != nil {
		return err
	}
	return checkBootstrapContext(source.scope.Context(ctx))
}

func validRecoveryScopeDevices(devices []controlplane.DeviceEntry) bool {
	if devices == nil {
		return false
	}
	seen := make(map[string]bool, len(devices))
	for _, device := range devices {
		if !protocol.ValidID(device.DeviceID) || !protocol.ValidID(device.UserID) || device.Name == "" || (device.Presence != "online" && device.Presence != "offline") || device.LastSeen < 0 || device.LastSeen > 1<<53-1 || seen[device.DeviceID] {
			return false
		}
		seen[device.DeviceID] = true
	}
	return true
}
