package peersession

import (
	"context"
	"crypto/ed25519"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// CurrentRegistration captures the account/fence that must still own a complete
// fresh catalog transaction. It is never a replacement for scoped identity reads.
func (manager *Manager) CurrentRegistration(userID string) (protocol.RegistrationFence, error) {
	fence, err := manager.registration()
	if err == nil {
		err = manager.withRegistration(fence, userID, nil)
	}
	return fence, err
}

// CommitScopedPins linearizes the caller's fresh scoped identities and durable
// catalog write with registration replacement. commit must do no network work.
func (manager *Manager) CommitScopedPins(fence protocol.RegistrationFence, userID string, identities []controlplane.PairIdentity, commit func() error) error {
	if commit == nil {
		return errors.New("p2p.invalid_request")
	}
	return manager.withRegistration(fence, userID, func() error {
		previous, revoked := manager.pins, manager.revokedPairs
		next := make(map[string]controlplane.PairIdentity, len(previous)+len(identities))
		for id, pin := range previous {
			next[id] = pin
		}
		nextRevoked := make(map[string]string, len(revoked))
		for id, networkID := range revoked {
			nextRevoked[id] = networkID
		}
		manager.pins, manager.revokedPairs = next, nextRevoked
		for _, identity := range identities {
			pin := identity
			remote, err := manager.targetDevice(pin)
			if err != nil {
				manager.pins, manager.revokedPairs = previous, revoked
				return err
			}
			pin.Pair.PairID = remote
			// The complete fresh transaction, not a cached pin, is authority to
			// admit an explicitly selected/re-authorized peer again.
			delete(manager.revokedPairs, remote)
			if err := manager.pinLocked(pin); err != nil {
				manager.pins, manager.revokedPairs = previous, revoked
				return err
			}
		}
		if err := commit(); err != nil {
			manager.pins, manager.revokedPairs = previous, revoked
			return err
		}
		// Only a successful catalog publication loses an older admission's pin.
		// Validation/commit failure must leave both the map and owner intact.
		for pairID := range manager.inboundAdmissions {
			manager.cancelChangedAdmissionLocked(pairID)
		}
		for pairID := range manager.manualWaiters {
			manager.cancelChangedManualWaitLocked(pairID)
		}
		return nil
	})
}

// RetireScopedPin releases only the old local authority. Session cleanup stays
// Manager-owned; callers may hold account.mu, so this never joins an emitter
// that can be waiting for that same lock.
func (manager *Manager) RetireScopedPin(pairID, networkID string) error {
	return manager.revokeExpected(pairID, networkID)
}

func (manager *Manager) CandidatesActive() bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.candidatesActive && !manager.closed
}

func (manager *Manager) ActivateCandidates(ctx context.Context) error {
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return errors.New("p2p.helper_unavailable")
	}
	if manager.accountUserID == "" {
		manager.mu.Unlock()
		return errors.New("p2p.user_login_required")
	}
	wasActive := manager.candidatesActive
	manager.candidatesActive = true
	manager.mu.Unlock()
	if err := manager.reconnectSignals(ctx, !wasActive); err != nil {
		manager.mu.Lock()
		manager.candidatesActive = wasActive
		manager.mu.Unlock()
		return err
	}
	return nil
}

// ScopedPairIdentity is a current-account read, never a v1 identity downgrade.
// This endpoint's pairRowID is the coordinator pairs-table record ID.
func (manager *Manager) ScopedPairIdentity(ctx context.Context, userID, networkID, pairRowID string) (controlplane.PairIdentity, error) {
	identity, fence, err := manager.readScopedIdentity(ctx, userID, networkID, pairRowID)
	if err == nil {
		err = manager.withRegistration(fence, userID, nil)
	}
	return identity, err
}

// PinScopedIdentity admits the fresh reply under the same owner barrier as the
// exact account/fence recheck. Catalog readers retain the original row ID while
// the live pin map uses the far device ID, like directed candidate operations.
func (manager *Manager) PinScopedIdentity(ctx context.Context, userID, networkID, pairRowID string) (controlplane.PairIdentity, error) {
	identity, fence, err := manager.readScopedIdentity(ctx, userID, networkID, pairRowID)
	if err != nil {
		return controlplane.PairIdentity{}, err
	}
	if identity.Pair.State != "active" {
		return identity, errors.New("p2p.pair_unauthorized")
	}
	err = manager.withRegistration(fence, userID, func() error {
		pin := identity
		remote, targetErr := manager.targetDevice(pin)
		if targetErr != nil {
			return targetErr
		}
		pin.Pair.PairID = remote
		if err := manager.pinLocked(pin); err != nil {
			return err
		}
		manager.cancelChangedAdmissionLocked(pin.Pair.PairID)
		manager.cancelChangedManualWaitLocked(pin.Pair.PairID)
		return nil
	})
	return identity, err
}

func (manager *Manager) readScopedIdentity(ctx context.Context, userID, networkID, pairRowID string) (controlplane.PairIdentity, protocol.RegistrationFence, error) {
	if !protocol.ValidID(userID) || !protocol.ValidID(networkID) || !protocol.ValidID(pairRowID) || manager.client.Account() != userID {
		return controlplane.PairIdentity{}, protocol.RegistrationFence{}, errors.New("p2p.user_unauthorized")
	}
	fence, err := manager.registration()
	if err != nil {
		return controlplane.PairIdentity{}, fence, err
	}
	identity, err := manager.client.ScopedPairIdentity(ctx, protocol.PairIdentityRequest{Registration: fence, UserID: userID, NetworkID: networkID, PairID: pairRowID})
	if err != nil {
		return identity, fence, err
	}
	local, remote := identity.Initiator, identity.Target
	if local.DeviceID != manager.config.Device.DeviceID {
		local, remote = remote, local
	}
	validState := identity.Pair.State == "active" || identity.Pair.State == "invited" || identity.Pair.State == "approved"
	if identity.Pair.PairID != pairRowID || identity.Pair.NetworkID != networkID || !validState || !protocol.ValidGeneration(identity.Pair.Revision) ||
		identity.Pair.Initiator != identity.Initiator.DeviceID || identity.Pair.Target != identity.Target.DeviceID ||
		!protocol.ValidID(local.DeviceID) || !protocol.ValidID(remote.DeviceID) || local.DeviceID == remote.DeviceID ||
		local.DeviceID != manager.config.Device.DeviceID || local.UserID != userID || remote.UserID != userID ||
		len(local.PublicKey) != ed25519.PublicKeySize || len(remote.PublicKey) != ed25519.PublicKeySize ||
		!ed25519.PublicKey(local.PublicKey).Equal(ed25519.PublicKey(manager.config.Device.PublicKey)) {
		return controlplane.PairIdentity{}, fence, errors.New("p2p.identity_mismatch")
	}
	if identity.Pair.State != "active" && identity.Pair.ExpiresAt <= time.Now().Unix() {
		return controlplane.PairIdentity{}, fence, errors.New("p2p.pair_expired")
	}
	return identity, fence, nil
}

func (manager *Manager) withRegistration(fence protocol.RegistrationFence, userID string, apply func() error) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed || manager.accountUserID != userID || manager.client.Account() != userID || manager.signals == nil {
		return errors.New("p2p.user_unauthorized")
	}
	owner := manager.signals
	owner.mu.Lock()
	defer owner.mu.Unlock()
	control, ok := owner.active.(controlSubscription)
	if !ok || owner.closed || owner.down {
		return errors.New("p2p.registration_stale")
	}
	current, err := control.Registration()
	if err != nil || current != fence {
		return errors.New("p2p.registration_stale")
	}
	if apply != nil {
		return apply()
	}
	return nil
}

// RetainPins removes authorization that a complete fresh catalog no longer
// carries. It never invents a new pin or preserves an omitted stale row.
func (manager *Manager) RetainPins(pairIDs []string) {
	wanted := make(map[string]bool, len(pairIDs))
	for _, pairID := range pairIDs {
		wanted[pairID] = true
	}
	manager.mu.Lock()
	var removed []string
	for pairID := range manager.pins {
		if !wanted[pairID] {
			removed = append(removed, pairID)
		}
	}
	manager.mu.Unlock()
	for _, pairID := range removed {
		manager.revoke(pairID)
	}
}
