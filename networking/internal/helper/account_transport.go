package helper

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type accountHTTPPhase uint8

const (
	accountHTTPUnknown accountHTTPPhase = iota
	accountHTTPSetup
	accountHTTPDevice
	accountHTTPClosed
)

// Caller owns account.mu. The phase is published by configure/restore/close,
// never inferred from a missing client or selected after an HTTP/TLS failure.
// Named authentication confirmations and certificate recovery do not use this
// ordinary Bearer transport selector; their owners remain explicit.
func (account *account) bearerClientLocked() (*controlplane.Client, error) {
	if account.closed || account.httpPhase == accountHTTPClosed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	switch account.httpPhase {
	case accountHTTPSetup:
		if account.base == nil || account.client != nil || account.manager != nil {
			return nil, errors.New("p2p.invalid_device_state")
		}
		return account.base, nil
	case accountHTTPDevice:
		if account.client == nil || !protocol.ValidID(account.device.DeviceID) || len(account.device.PublicKey) != ed25519.PublicKeySize {
			return nil, errors.New("p2p.invalid_device_state")
		}
		certificate, err := x509.ParseCertificate(account.device.Certificate)
		if err != nil || certificate.Subject.CommonName != account.device.DeviceID || certificate.IsCA {
			return nil, errors.New("p2p.invalid_device_state")
		}
		key, ok := certificate.PublicKey.(ed25519.PublicKey)
		if !ok || !key.Equal(ed25519.PublicKey(account.device.PublicKey)) || time.Now().Before(certificate.NotBefore) {
			return nil, errors.New("p2p.invalid_device_state")
		}
		if !time.Now().Before(certificate.NotAfter) {
			return nil, errors.New("p2p.certificate_recovery_required")
		}
		return account.client, nil
	default:
		return nil, errors.New("p2p.invalid_device_state")
	}
}

// Authentication is independent from candidate activation. Preselect exactly
// once from a fully validated original identity: setup and genuinely expired
// devices have a named public owner; a valid device (including recovery-pending
// after issuance) uses its original mTLS client. A selected request's TLS/HTTP
// failure, or expiry during that request, never authorizes a public replay.
// Caller owns account.mu, including durable credential/provenance verification.
func (account *account) authenticationClientLocked(ctx context.Context) (*controlplane.Client, error) {
	if _, err := account.authRecoveryRequiredLocked(ctx); err != nil {
		return nil, err
	}
	if account.httpPhase == accountHTTPSetup {
		return account.base, nil
	}
	certificate, err := x509.ParseCertificate(account.device.Certificate)
	if err != nil {
		return nil, errors.New("p2p.invalid_device_state")
	}
	if !time.Now().Before(certificate.NotAfter) {
		return account.base, nil
	}
	return account.client, nil
}
