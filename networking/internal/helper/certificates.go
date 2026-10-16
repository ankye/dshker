package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

const CertificateMaintenanceInterval = time.Hour
const certificateOperationTimeout = 45 * time.Second

type certificateRequest struct {
	Device     controlplane.Device `json:"device"`
	PrivateKey []byte              `json:"privateKey"`
}

type certificateResult struct {
	DeviceID    string `json:"deviceId"`
	PublicKey   []byte `json:"publicKey"`
	Certificate []byte `json:"certificate"`
}

// Optional fields are admitted only here. The shared wire decoder remains strict.
func decodeCertificateRequest(data json.RawMessage) (certificateRequest, string, string, error) {
	var fields map[string]json.RawMessage
	// Decode validates duplicate keys, nulls, limits and trailing values first.
	var required certificateRequest
	if protocol.Decode(data, &required) != nil || json.Unmarshal(data, &fields) != nil {
		return required, "", "", errors.New("p2p.invalid_request")
	}
	var networkID, token string
	for key, target := range map[string]*string{"networkId": &networkID, "token": &token} {
		if value, exists := fields[key]; exists {
			if json.Unmarshal(value, target) != nil || *target == "" {
				return required, "", "", errors.New("p2p.invalid_request")
			}
			delete(fields, key)
		}
	}
	remaining, err := json.Marshal(fields)
	if err != nil || protocol.DecodeExact(remaining, &required) != nil || (networkID != "" && !protocol.ValidID(networkID)) {
		return required, "", "", errors.New("p2p.invalid_request")
	}
	return required, networkID, token, nil
}

func (host *Host) certificate(ctx context.Context, account *account, data json.RawMessage) (any, error) {
	request, networkID, token, err := decodeCertificateRequest(data)
	if err != nil {
		return nil, err
	}
	defer clear(request.PrivateKey)
	device, err := host.prepareCertificate(ctx, account, request.Device, request.PrivateKey, networkID, token)
	if err != nil {
		return nil, err
	}
	return certificateResult{device.DeviceID, device.PublicKey, device.Certificate}, nil
}

func sameDevice(left, right controlplane.Device) bool {
	return left.DeviceID == right.DeviceID && bytes.Equal(left.PublicKey, right.PublicKey)
}

// device.restore historically carries the signed-in account as Device.UserID.
// A certificate owns a device/key, while heartbeat presence owns a user session.
// Resolve the original owner without changing that presence contract.
func (host *Host) restoreDeviceOwner(ctx context.Context, account *account, supplied controlplane.Device, private ed25519.PrivateKey) (controlplane.Device, error) {
	canonical, err := host.LoadCredential(account.identity.ServiceID)
	if err != nil && !errors.Is(err, secret.ErrMissing) {
		return controlplane.Device{}, errors.New("p2p.certificate_sync_failed")
	}
	if err == nil && (canonical.DeviceID != supplied.DeviceID || !bytes.Equal(canonical.PublicKey, supplied.PublicKey)) {
		return controlplane.Device{}, errors.New("p2p.identity_mismatch")
	}
	if _, validation := account.base.ValidateDevice(supplied, private, account.identity, true); validation != nil {
		return controlplane.Device{}, validation
	}
	current, err := account.base.ReadCertificate(ctx, supplied.DeviceID, private, account.identity)
	if err != nil {
		return controlplane.Device{}, certificateFailure(ctx, err)
	}
	supplied.UserID = current.UserID
	return supplied, nil
}

// All callers hold account.mu, including the timer and both restore paths.
func (host *Host) prepareCertificate(ctx context.Context, account *account, supplied controlplane.Device, private ed25519.PrivateKey, networkID, token string) (controlplane.Device, error) {
	operation, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(host.ctx, cancel)
	defer stop()
	defer cancel()
	ctx = operation
	if err := certificateContext(ctx); err != nil {
		return controlplane.Device{}, err
	}
	leaf, err := account.base.ValidateDevice(supplied, private, account.identity, true)
	if err != nil {
		return controlplane.Device{}, err
	}
	if account.manager != nil && (account.device.DeviceID != supplied.DeviceID || !bytes.Equal(account.device.PublicKey, supplied.PublicKey)) {
		return controlplane.Device{}, errors.New("p2p.identity_mismatch")
	}
	device := supplied
	canonical, err := host.LoadCredential(account.identity.ServiceID)
	if err == nil {
		if canonical.DeviceID != supplied.DeviceID || !bytes.Equal(canonical.PublicKey, supplied.PublicKey) || !bytes.Equal(canonical.PrivateKey, private) || canonical.Endpoints != account.endpoints || !bytes.Equal(canonical.ServiceKey, account.identity.PublicKey) {
			return controlplane.Device{}, errors.New("p2p.identity_mismatch")
		}
		storedLeaf, err := account.base.ValidateDevice(canonical.device(), private, account.identity, true)
		if err != nil {
			return controlplane.Device{}, err
		}
		if !storedLeaf.NotAfter.Before(leaf.NotAfter) {
			device, leaf = canonical.device(), storedLeaf
		}
	} else if !errors.Is(err, secret.ErrMissing) {
		return controlplane.Device{}, errors.New("p2p.certificate_sync_failed")
	}
	if account.manager != nil && !sameDevice(account.device, device) {
		return controlplane.Device{}, errors.New("p2p.identity_mismatch")
	}
	metadata, err := host.loadCertificateMetadata(account.identity.ServiceID)
	if err != nil {
		return controlplane.Device{}, err
	}
	if _, err := readCredentialIndex(host.certificateStore()); err != nil {
		return controlplane.Device{}, err
	}
	if networkID != "" {
		if metadata.NetworkID != "" && metadata.NetworkID != networkID {
			return controlplane.Device{}, errors.New("p2p.certificate_recovery_forbidden")
		}
		metadata.NetworkID = networkID
	}
	// Query before every adoption, even outside the renewal window. Two older
	// local copies can both carry the same linked-account projection as owner.
	current, err := account.base.ReadCertificate(ctx, device.DeviceID, private, account.identity)
	if err != nil {
		return controlplane.Device{}, certificateFailure(ctx, err)
	}
	currentLeaf, err := account.base.ValidateDevice(current, private, account.identity, true)
	if err != nil {
		return controlplane.Device{}, err
	}
	if !sameDevice(current, device) {
		return controlplane.Device{}, errors.New("p2p.identity_mismatch")
	}
	if currentLeaf.NotAfter.Before(leaf.NotAfter) {
		return controlplane.Device{}, errors.New("p2p.certificate_sync_failed")
	}
	// UserID is the server's device-owner projection, not the certificate's
	// signed identity. Older network joins and restores stored a linked account
	// here in both local copies; only original-key server readback can repair it.
	device.UserID = current.UserID
	if err := host.persistCertificate(ctx, account, device, private, metadata); err != nil {
		return controlplane.Device{}, err
	}
	if !bytes.Equal(current.Certificate, device.Certificate) && time.Now().Before(currentLeaf.NotAfter) {
		device.Certificate, leaf = current.Certificate, currentLeaf
		metadata.PendingRequestID = ""
		if err := host.persistCertificate(ctx, account, device, private, metadata); err != nil {
			return controlplane.Device{}, err
		}
		return host.activateCertificate(account, device, private)
	}
	if leaf.NotAfter.After(time.Now().Add(controlplane.CertificateRenewalWindow)) {
		metadata.PendingRequestID = ""
		if err := host.persistCertificate(ctx, account, device, private, metadata); err != nil {
			return controlplane.Device{}, err
		}
		return host.activateCertificate(account, device, private)
	}
	device, err = host.issueCertificate(ctx, account, device, private, &metadata, token)
	if err != nil {
		return controlplane.Device{}, err
	}
	metadata.PendingRequestID = ""
	if err := host.persistCertificate(ctx, account, device, private, metadata); err != nil {
		return controlplane.Device{}, err
	}
	return host.activateCertificate(account, device, private)
}

func (host *Host) issueCertificate(ctx context.Context, account *account, device controlplane.Device, private ed25519.PrivateKey, metadata *certificateMetadata, token string) (controlplane.Device, error) {
	leaf, err := account.base.ValidateDevice(device, private, account.identity, true)
	if err != nil {
		return controlplane.Device{}, err
	}
	expired := !time.Now().Before(leaf.NotAfter)
	if expired && (metadata.NetworkID == "" || token == "") {
		return controlplane.Device{}, errors.New("p2p.certificate_recovery_required")
	}
	if metadata.PendingRequestID == "" {
		metadata.PendingRequestID = protocol.NewID()
	}
	if err := host.saveCertificateMetadata(account.identity.ServiceID, *metadata); err != nil {
		return controlplane.Device{}, err
	}
	var issued controlplane.Device
	if expired {
		grant, grantErr := account.base.EnrollmentToken(ctx, token, metadata.NetworkID)
		if grantErr != nil {
			return controlplane.Device{}, certificateFailure(ctx, grantErr)
		}
		if len(grant.Token) != 64 || grant.NetworkID != metadata.NetworkID || grant.ExpiresAt <= time.Now().Unix() {
			return controlplane.Device{}, errors.New("p2p.invalid_server_response")
		}
		issued, err = account.base.RecoverCertificate(ctx, device, private, account.identity, metadata.PendingRequestID, grant.Token)
	} else {
		client := account.client
		if client == nil {
			client, err = account.base.WithDevice(device, private, account.identity)
			if err != nil {
				return controlplane.Device{}, err
			}
			defer client.Close()
		} else if err := client.UpdateCertificate(device, private, account.identity); err != nil {
			return controlplane.Device{}, err
		}
		issued, err = client.RenewCertificate(ctx, device, private, account.identity, metadata.PendingRequestID)
	}
	if err != nil {
		return controlplane.Device{}, certificateFailure(ctx, err)
	}
	readback, err := account.base.ReadCertificate(ctx, device.DeviceID, private, account.identity)
	if err != nil {
		return controlplane.Device{}, certificateFailure(ctx, err)
	}
	if !sameDevice(readback, device) || !bytes.Equal(readback.Certificate, issued.Certificate) {
		return controlplane.Device{}, errors.New("p2p.certificate_sync_failed")
	}
	return issued, nil
}

func (host *Host) persistCertificate(ctx context.Context, account *account, device controlplane.Device, private ed25519.PrivateKey, metadata certificateMetadata) error {
	if err := certificateContext(ctx); err != nil {
		return err
	}
	if err := host.SaveCredential(account.identity.ServiceID, device, private); err != nil {
		return errors.New("p2p.certificate_persist_failed")
	}
	if err := certificateContext(ctx); err != nil {
		return err
	}
	return host.saveCertificateMetadata(account.identity.ServiceID, metadata)
}

func (host *Host) activateCertificate(account *account, device controlplane.Device, private ed25519.PrivateKey) (controlplane.Device, error) {
	if account.client != nil {
		if err := account.client.UpdateCertificate(device, private, account.identity); err != nil {
			return controlplane.Device{}, err
		}
		account.device = device
	}
	return device, nil
}

func certificateContext(ctx context.Context) error {
	if ctx.Err() != nil {
		return errors.New("p2p.request_cancelled")
	}
	return nil
}

func certificateFailure(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return errors.New("p2p.request_cancelled")
	}
	switch err.Error() {
	case "p2p.user_unauthorized", "p2p.user_login_required":
		return errors.New("p2p.certificate_recovery_required")
	case "p2p.network_forbidden", "p2p.network_not_found", "p2p.network_unauthorized", "p2p.binding_unauthorized", "p2p.device_unauthorized", "p2p.device_not_bound", "p2p.invalid_enrollment_token":
		return errors.New("p2p.certificate_recovery_forbidden")
	case "p2p.server_unavailable", "p2p.protocol_limit":
		return errors.New("p2p.certificate_sync_failed")
	}
	return err
}

func (account *account) maintainCertificates(ctx context.Context) {
	ticker := time.NewTicker(CertificateMaintenanceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := account.maintainCertificate(ctx); err != nil && ctx.Err() == nil {
				log.Printf("[p2p] certificate maintenance failed for service %s: %v", account.identity.ServiceID, err)
			}
		}
	}
}

func (account *account) maintainCertificate(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, certificateOperationTimeout)
	defer cancel()
	account.mu.Lock()
	defer account.mu.Unlock()
	if err := certificateContext(ctx); err != nil {
		return err
	}
	credential, err := account.host.LoadCredential(account.identity.ServiceID)
	if errors.Is(err, secret.ErrMissing) {
		return nil
	}
	if err != nil {
		return err
	}
	account.directory.mu.Lock()
	token := account.directory.token
	account.directory.mu.Unlock()
	_, err = account.host.prepareCertificate(ctx, account, credential.device(), credential.PrivateKey, "", token)
	return err
}
