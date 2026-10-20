package helper

import (
	"bytes"
	"context"
	"errors"
	"log"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
)

// Provenance exists only after the fully validated expired-device auth branch.
// Issuance may replace the certificate, never this original device/key/client
// identity. A valid-certificate network failure cannot establish this owner.
type authRecoverySource struct {
	account               *account
	client, base          *controlplane.Client
	manager               *peersession.Manager
	serviceID, deviceID   string
	publicKey, serviceKey []byte
	endpoints             controlplane.Endpoints
}

// Caller owns account.mu, as for the existing login/restore admission.
func (account *account) reportAccount(ctx context.Context, userID string) error {
	if err := checkBootstrapContext(ctx); err != nil {
		return err
	}
	if account.manager != nil {
		if err := account.manager.SetAccount(ctx, userID); err != nil {
			return err
		}
	} else {
		account.client.SetAccount(userID)
	}
	return checkBootstrapContext(ctx)
}

// Caller owns account.mu. Only a genuinely expired, fully validated original
// device may separate public authentication from pending device activation.
func (account *account) authRecoveryRequiredLocked(ctx context.Context) (bool, error) {
	if err := checkBootstrapContext(ctx); err != nil {
		return false, err
	}
	if ctx.Err() != nil || account.host.ctx.Err() != nil || (account.lifetime != nil && account.lifetime.Err() != nil) {
		return false, errors.New("p2p.request_cancelled")
	}
	if account.closed || account.httpPhase == accountHTTPClosed {
		return false, errors.New("p2p.service_unconfigured")
	}
	if (account.activationPending != nil || account.activationSource != nil) && account.httpPhase != accountHTTPDevice {
		return false, errors.New("p2p.invalid_device_state")
	}
	switch account.httpPhase {
	case accountHTTPSetup:
		if account.base == nil || account.client != nil || account.manager != nil {
			return false, errors.New("p2p.invalid_device_state")
		}
		return false, nil
	case accountHTTPDevice:
		if account.base == nil || account.client == nil || account.client == account.base {
			return false, errors.New("p2p.invalid_device_state")
		}
		continuing := account.activationPending != nil || account.activationSource != nil
		if continuing {
			if account.activationPending == nil || account.activationPending.Error() != "p2p.certificate_recovery_required" || account.activationSource == nil {
				return false, errors.New("p2p.invalid_device_state")
			}
			source := account.activationSource
			if source.account != account || source.client != account.client || source.base != account.base || source.manager != account.manager || source.serviceID != account.identity.ServiceID || source.deviceID != account.device.DeviceID || source.endpoints != account.endpoints || !bytes.Equal(source.publicKey, account.device.PublicKey) || !bytes.Equal(source.serviceKey, account.identity.PublicKey) {
				return false, errors.New("p2p.identity_mismatch")
			}
		}
		account.host.mu.Lock()
		current := !account.host.closed && account.host.accounts[account.identity.ServiceID] == account
		account.host.mu.Unlock()
		if !current {
			return false, errors.New("p2p.service_unconfigured")
		}
		original, err := account.host.LoadCredential(account.identity.ServiceID)
		if fence := checkBootstrapContext(ctx); fence != nil {
			clear(original.PrivateKey)
			return false, fence
		}
		if err != nil {
			return false, recoveryScopeCredentialError(err)
		}
		defer clear(original.PrivateKey)
		if !sameDevice(account.device, original.device()) || original.Endpoints != account.endpoints || !bytes.Equal(original.ServiceKey, account.identity.PublicKey) {
			return false, errors.New("p2p.identity_mismatch")
		}
		if _, err := account.base.ValidateDevice(original.device(), original.PrivateKey, account.identity, true); err != nil {
			return false, err
		}
		leaf, err := account.client.ValidateDevice(account.device, original.PrivateKey, account.identity, true)
		if err != nil {
			return false, err
		}
		if ctx.Err() != nil {
			return false, errors.New("p2p.request_cancelled")
		}
		return !time.Now().Before(leaf.NotAfter) || continuing, nil
	default:
		return false, errors.New("p2p.invalid_device_state")
	}
}

func (account *account) deferAccountActivationLocked(ctx context.Context, userID string) error {
	scope, exists := selectedSessionScopeFromContext(ctx)
	if !exists || scope.account != account || !scope.hasSession {
		return errors.New("p2p.user_scope_mismatch")
	}
	if err := checkBootstrapContext(ctx); err != nil {
		return err
	}
	if account.manager != nil {
		completion, err := account.manager.FenceAccountForCertificateRecovery(userID)
		if completion != nil {
			account.authRecoveryJoins = append(account.authRecoveryJoins, completion)
		}
		if err != nil {
			return err
		}
	} else {
		account.client.SetAccount(userID)
	}
	if err := checkBootstrapContext(ctx); err != nil {
		return err
	}
	source := account.activationSource
	if source == nil {
		source = &authRecoverySource{account: account, client: account.client, base: account.base, manager: account.manager, serviceID: account.identity.ServiceID, deviceID: account.device.DeviceID, publicKey: append([]byte(nil), account.device.PublicKey...), serviceKey: append([]byte(nil), account.identity.PublicKey...), endpoints: account.endpoints}
	}
	if err := scope.Publish(ctx, func() error {
		account.activationPending = errors.New("p2p.certificate_recovery_required")
		account.activationSource = source
		return nil
	}); err != nil {
		return err
	}
	log.Printf("[p2p] device activation pending for service %s; code=%s", account.identity.ServiceID, account.activationPending.Error())
	return nil
}
