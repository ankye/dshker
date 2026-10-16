package controlplane

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"strconv"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

const CertificateRenewalWindow = 7 * 24 * time.Hour

// ValidateDevice permits expiry only for the explicit certificate recovery path.
// All other identity, CA, key, signature and ClientAuth checks are identical.
func (client *Client) ValidateDevice(device Device, private ed25519.PrivateKey, authority Identity, allowExpired bool) (*x509.Certificate, error) {
	if authority.Version != protocol.Version || len(authority.PublicKey) != ed25519.PublicKeySize || authority.ServiceID != protocol.KeyID(authority.PublicKey) || authority.HTTPSOrigin != client.endpoints.HTTPSOrigin || authority.WSSURL != client.endpoints.WSSURL || authority.STUNAddress != client.endpoints.STUNAddress {
		return nil, errors.New("p2p.invalid_service_identity")
	}
	if len(private) != ed25519.PrivateKeySize || !bytes.Equal(private, ed25519.NewKeyFromSeed(private.Seed())) || !private.Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(device.PublicKey)) || !protocol.ValidID(device.DeviceID) || !protocol.ValidID(device.UserID) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	certificate, err := x509.ParseCertificate(device.Certificate)
	if err != nil || certificate.IsCA || certificate.Subject.CommonName != device.DeviceID {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	public, ok := certificate.PublicKey.(ed25519.PublicKey)
	if !ok || !public.Equal(ed25519.PublicKey(device.PublicKey)) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	ca, err := x509.ParseCertificate(authority.Certificate)
	if err != nil || !ca.IsCA || ca.CheckSignatureFrom(ca) != nil {
		return nil, errors.New("p2p.invalid_service_identity")
	}
	caPublic, ok := ca.PublicKey.(ed25519.PublicKey)
	if !ok || !caPublic.Equal(ed25519.PublicKey(authority.PublicKey)) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	now := time.Now()
	if now.Before(ca.NotBefore) || now.After(ca.NotAfter) || now.Before(certificate.NotBefore) || !certificate.NotAfter.After(certificate.NotBefore) {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	hasClientAuth := false
	for _, usage := range certificate.ExtKeyUsage {
		hasClientAuth = hasClientAuth || usage == x509.ExtKeyUsageClientAuth
	}
	if !hasClientAuth {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	verificationTime := now
	if allowExpired && !now.Before(certificate.NotAfter) {
		verificationTime = certificate.NotAfter.Add(-time.Nanosecond)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: pool, CurrentTime: verificationTime, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	return certificate, nil
}

// UpdateCertificate changes future TLS handshakes without replacing the client,
// signalling subscription, peer manager, or established peer transports.
func (client *Client) UpdateCertificate(device Device, private ed25519.PrivateKey, authority Identity) error {
	leaf, err := client.ValidateDevice(device, private, authority, false)
	if err != nil {
		return err
	}
	if client.deviceID != "" && client.deviceID != device.DeviceID {
		return errors.New("p2p.identity_mismatch")
	}
	certificate := &tls.Certificate{Certificate: [][]byte{append([]byte(nil), device.Certificate...)}, PrivateKey: ed25519.PrivateKey(append([]byte(nil), private...)), Leaf: leaf}
	client.certificateMu.Lock()
	client.certificate = certificate
	client.certificateMu.Unlock()
	client.transport.CloseIdleConnections()
	return nil
}

func (client *Client) clientCertificate(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
	client.certificateMu.RLock()
	certificate := client.certificate
	client.certificateMu.RUnlock()
	if certificate == nil || certificate.Leaf == nil || !time.Now().Before(certificate.Leaf.NotAfter) || time.Now().Before(certificate.Leaf.NotBefore) {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	return certificate, nil
}

type certificateQuery struct {
	ServiceID string `json:"serviceId"`
	DeviceID  string `json:"deviceId"`
	PublicKey []byte `json:"publicKey"`
	IssuedAt  int64  `json:"issuedAt"`
	Signature string `json:"signature"`
}

func newCertificateQuery(serviceID, deviceID string, private ed25519.PrivateKey, now time.Time) (certificateQuery, error) {
	if !protocol.ValidID(serviceID) || !protocol.ValidID(deviceID) || len(private) != ed25519.PrivateKeySize {
		return certificateQuery{}, errors.New("p2p.invalid_request")
	}
	if !bytes.Equal(private, ed25519.NewKeyFromSeed(private.Seed())) {
		return certificateQuery{}, errors.New("p2p.identity_mismatch")
	}
	query := certificateQuery{ServiceID: serviceID, DeviceID: deviceID, PublicKey: append([]byte(nil), private.Public().(ed25519.PublicKey)...), IssuedAt: now.Unix()}
	message := "dshker.certificate-query.v1\n" + serviceID + "\n" + deviceID + "\n" + base64.RawURLEncoding.EncodeToString(query.PublicKey) + "\n" + strconv.FormatInt(query.IssuedAt, 10)
	query.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(message)))
	return query, nil
}

// ReadCertificate proves ownership with the original key. An expired result is
// authenticated data for recovery, never a TLS credential.
func (client *Client) ReadCertificate(ctx context.Context, deviceID string, private ed25519.PrivateKey, authority Identity) (Device, error) {
	query, err := newCertificateQuery(authority.ServiceID, deviceID, private, time.Now())
	if err != nil {
		return Device{}, err
	}
	var result Device
	public, err := New(client.endpoints, client.transport.TLSClientConfig.RootCAs)
	if err != nil {
		return Device{}, err
	}
	defer public.Close()
	if err := public.call(ctx, "POST", "/v1/certificate-query", "", query, &result); err != nil {
		return Device{}, err
	}
	if result.DeviceID != deviceID || !bytes.Equal(result.PublicKey, query.PublicKey) {
		return Device{}, errors.New("p2p.identity_mismatch")
	}
	if _, err := client.ValidateDevice(result, private, authority, true); err != nil {
		return Device{}, err
	}
	return result, nil
}

func (client *Client) RenewCertificate(ctx context.Context, device Device, private ed25519.PrivateKey, authority Identity, requestID string) (Device, error) {
	if _, err := client.ValidateDevice(device, private, authority, false); err != nil {
		return Device{}, err
	}
	if client.deviceID != device.DeviceID || !protocol.ValidID(requestID) {
		return Device{}, errors.New("p2p.identity_mismatch")
	}
	csr, err := DeviceCSR(private)
	if err != nil {
		return Device{}, err
	}
	return client.issueCertificate(ctx, "/v1/renew-certificate", struct {
		RequestID string `json:"requestId"`
		CSR       string `json:"csr"`
	}{requestID, csr}, device, private, authority)
}

func (client *Client) RecoverCertificate(ctx context.Context, device Device, private ed25519.PrivateKey, authority Identity, requestID, token string) (Device, error) {
	if _, err := client.ValidateDevice(device, private, authority, true); err != nil {
		return Device{}, err
	}
	if !protocol.ValidID(requestID) || token == "" {
		return Device{}, errors.New("p2p.invalid_request")
	}
	csr, err := DeviceCSR(private)
	if err != nil {
		return Device{}, err
	}
	public, err := New(client.endpoints, client.transport.TLSClientConfig.RootCAs)
	if err != nil {
		return Device{}, err
	}
	defer public.Close()
	return public.issueCertificate(ctx, "/v1/recover-certificate", struct {
		DeviceID  string `json:"deviceId"`
		RequestID string `json:"requestId"`
		CSR       string `json:"csr"`
		Token     string `json:"token"`
	}{device.DeviceID, requestID, csr, token}, device, private, authority)
}

func (client *Client) issueCertificate(ctx context.Context, path string, request any, device Device, private ed25519.PrivateKey, authority Identity) (Device, error) {
	var result struct {
		Certificate []byte `json:"certificate"`
	}
	if err := client.call(ctx, "POST", path, "", request, &result); err != nil {
		return Device{}, err
	}
	device.Certificate = result.Certificate
	if _, err := client.ValidateDevice(device, private, authority, false); err != nil {
		return Device{}, err
	}
	return device, nil
}
