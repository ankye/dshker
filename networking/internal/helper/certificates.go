package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
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

type restoreCertificateKey struct{}
type restoreCallerKey struct{}

type restoreCallerScope struct {
	generation   uint64
	session      persistedAccountSession
	hasSession   bool
	sessionOwner *bootstrapSessionOwner
	err          error
}

// This is one restore's local publication fence, not a retained certificate or
// authorization result. Only this operation's confirmed writes advance its hash.
type restoreCertificateAdmission struct {
	host             *Host
	account          *account
	base             *controlplane.Client
	serviceID        string
	endpoints        controlplane.Endpoints
	serviceKey       [32]byte
	generation       uint64
	credential       [32]byte
	hasCredential    bool
	session          [32]byte
	sessionExpiresAt int64
	hasSession       bool
	sessionOwner     *bootstrapSessionOwner
	previousGuard    func() error
}

func credentialFingerprint(record storedCredential) [32]byte {
	body, _ := json.Marshal(record) // This fixed DTO has no fallible marshaler.
	defer clear(body)
	return sha256.Sum256(body)
}

func (admission *restoreCertificateAdmission) check(ctx context.Context) error {
	if ctx.Err() != nil || admission.host.ctx.Err() != nil {
		return errors.New("p2p.request_cancelled")
	}
	if admission.previousGuard != nil {
		if err := admission.previousGuard(); err != nil {
			return err
		}
	}
	host, account := admission.host, admission.account
	host.mu.Lock()
	current := !host.closed && host.accounts[admission.serviceID] == account
	host.mu.Unlock()
	if !current || account.closed {
		return errors.New("p2p.service_unconfigured")
	}
	if account.base != admission.base || account.identity.ServiceID != admission.serviceID || account.endpoints != admission.endpoints || sha256.Sum256(account.identity.PublicKey) != admission.serviceKey {
		return errors.New("p2p.identity_mismatch")
	}
	host.bootstrapMu.Lock()
	current = host.bootstrapGeneration[admission.serviceID] == admission.generation &&
		(admission.sessionOwner == nil || !admission.sessionOwner.revoked && host.bootstrapSessionOwners[admission.serviceID] == admission.sessionOwner)
	host.bootstrapMu.Unlock()
	if !current {
		return errors.New("p2p.user_scope_mismatch")
	}
	record, err := host.LoadCredential(admission.serviceID)
	if err != nil && !errors.Is(err, secret.ErrMissing) {
		return errors.New("p2p.certificate_sync_failed")
	}
	defer clear(record.PrivateKey)
	if (err == nil) != admission.hasCredential || err == nil && credentialFingerprint(record) != admission.credential {
		return errors.New("p2p.identity_mismatch")
	}
	session, exists, err := host.readAccountSession(admission.serviceID)
	if err != nil {
		return err
	}
	if exists != admission.hasSession || exists && (sha256.Sum256([]byte(session.Token)) != admission.session || session.ExpiresAt != admission.sessionExpiresAt) {
		return errors.New("p2p.user_scope_mismatch")
	}
	if exists && session.ExpiresAt <= time.Now().Unix() {
		return errors.New("p2p.user_session_expired")
	}
	return nil
}

// Owner resolution and preparation share the one fresh canonical query inside
// prepareCertificate. Both shell restore and headless restore use this boundary;
// standalone certificate operations still perform their own independent query.
func (host *Host) prepareRestoreCertificate(ctx context.Context, account *account, supplied controlplane.Device, private ed25519.PrivateKey) (context.Context, controlplane.Device, error) {
	canonical, err := host.LoadCredential(account.identity.ServiceID)
	if err != nil && !errors.Is(err, secret.ErrMissing) {
		return ctx, controlplane.Device{}, errors.New("p2p.certificate_sync_failed")
	}
	defer clear(canonical.PrivateKey)
	if err == nil && (canonical.DeviceID != supplied.DeviceID || !bytes.Equal(canonical.PublicKey, supplied.PublicKey)) {
		return ctx, controlplane.Device{}, errors.New("p2p.identity_mismatch")
	}
	if _, validation := account.base.ValidateDevice(supplied, private, account.identity, true); validation != nil {
		return ctx, controlplane.Device{}, validation
	}
	admission := &restoreCertificateAdmission{host: host, account: account, base: account.base, serviceID: account.identity.ServiceID, endpoints: account.endpoints, serviceKey: sha256.Sum256(account.identity.PublicKey), hasCredential: err == nil, credential: credentialFingerprint(canonical)}
	host.bootstrapMu.Lock()
	admission.generation = host.bootstrapGeneration[admission.serviceID]
	host.bootstrapMu.Unlock()
	session, exists, err := host.readAccountSession(admission.serviceID)
	if err != nil {
		return ctx, controlplane.Device{}, err
	}
	admission.hasSession, admission.sessionExpiresAt = exists, session.ExpiresAt
	admission.session = sha256.Sum256([]byte(session.Token))
	host.bootstrapMu.Lock()
	if owner := host.bootstrapSessionOwners[admission.serviceID]; exists && owner != nil && owner.matches(session) {
		admission.sessionOwner = owner
	}
	host.bootstrapMu.Unlock()
	if caller, ok := ctx.Value(restoreCallerKey{}).(restoreCallerScope); ok {
		if caller.err != nil {
			return ctx, controlplane.Device{}, caller.err
		}
		admission.generation = caller.generation
		admission.sessionOwner = caller.sessionOwner
		admission.hasSession, admission.sessionExpiresAt = caller.hasSession, caller.session.ExpiresAt
		admission.session = sha256.Sum256([]byte(caller.session.Token))
	}
	admission.previousGuard, _ = ctx.Value(bootstrapGuardKey{}).(func() error)
	ctx = context.WithValue(ctx, restoreCertificateKey{}, admission)
	guarded := ctx
	ctx = context.WithValue(ctx, bootstrapGuardKey{}, func() error { return admission.check(guarded) })
	device, err := host.prepareCertificate(ctx, account, supplied, private, "", "")
	return ctx, device, err
}

// All callers hold account.mu, including the timer and both restore paths.
func (host *Host) prepareCertificate(ctx context.Context, account *account, supplied controlplane.Device, private ed25519.PrivateKey, networkID, token string) (controlplane.Device, error) {
	if account.closed {
		return controlplane.Device{}, errors.New("p2p.service_unconfigured")
	}
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
	if err := certificateContext(ctx); err != nil {
		return controlplane.Device{}, err
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
	if _, guarded := ctx.Value(restoreCertificateKey{}).(*restoreCertificateAdmission); guarded {
		// Expected-record comparison, write/readback and expected-record advance
		// share the same lock as independent SaveCredential writers. No foreign
		// writer can slip between the comparison and this operation's write.
		host.credentialMu.Lock()
		defer host.credentialMu.Unlock()
		return host.persistRestoreCertificateLocked(ctx, account, device, private, metadata)
	}
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

func (host *Host) persistRestoreCertificateLocked(ctx context.Context, account *account, device controlplane.Device, private ed25519.PrivateKey, metadata certificateMetadata) error {
	if err := certificateContext(ctx); err != nil {
		return err
	}
	if err := host.saveCredentialLocked(account.identity.ServiceID, device, private); err != nil {
		return errors.New("p2p.certificate_persist_failed")
	}
	admission := ctx.Value(restoreCertificateKey{}).(*restoreCertificateAdmission)
	admission.credential = credentialFingerprint(storedCredential{Version: 1, ServiceID: admission.serviceID, Endpoints: admission.endpoints, ServiceKey: account.identity.PublicKey, DeviceID: device.DeviceID, UserID: device.UserID, Name: device.Name, PublicKey: device.PublicKey, Certificate: device.Certificate, PrivateKey: private})
	admission.hasCredential = true
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
	if admission, ok := ctx.Value(restoreCertificateKey{}).(*restoreCertificateAdmission); ok {
		return admission.check(ctx)
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
		return &certificateCarrierFailure{cause: err}
	}
	return err
}

// Preserve the established public refusal while retaining its real carrier
// cause for the explicit bootstrap transient whitelist. Corrupt local records
// that independently return certificate_sync_failed have no transient cause.
type certificateCarrierFailure struct{ cause error }

func (failure *certificateCarrierFailure) Error() string { return "p2p.certificate_sync_failed" }
func (failure *certificateCarrierFailure) Unwrap() error { return failure.cause }

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
	if account.closed {
		return errors.New("p2p.service_unconfigured")
	}
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
