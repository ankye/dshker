package controlplane

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// Client owns one explicitly configured service origin. It never follows redirects.
type Client struct {
	endpoints Endpoints
	http      *http.Client
	transport *http.Transport
	deviceID  string
}

func New(endpoints Endpoints, roots *x509.CertPool) (*Client, error) {
	if err := endpoints.Validate(); err != nil {
		return nil, err
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}, MaxResponseHeaderBytes: 16 * 1024, IdleConnTimeout: 30 * time.Second}
	return &Client{endpoints: endpoints, http: &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, transport: transport}, nil
}

func (endpoints Endpoints) Validate() error {
	origin, err := url.Parse(endpoints.HTTPSOrigin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Opaque != "" {
		return errors.New("p2p.invalid_service_endpoint")
	}
	wss, err := url.Parse(endpoints.WSSURL)
	if err != nil || wss.Scheme != "wss" || wss.Host != origin.Host || wss.User != nil || wss.Path != "/v1/signals" || wss.RawQuery != "" || wss.Fragment != "" || wss.RawPath != "" {
		return errors.New("p2p.invalid_signal_endpoint")
	}
	host, port, err := net.SplitHostPort(endpoints.STUNAddress)
	number, parseErr := strconv.Atoi(port)
	if err != nil || parseErr != nil || host == "" || strings.ContainsAny(host, "/?#@ \t\r\n") || number < 1 || number > 65535 {
		return errors.New("p2p.invalid_stun_endpoint")
	}
	return nil
}

func (client *Client) Close() { client.transport.CloseIdleConnections() }

func (client *Client) WithDevice(device Device, private ed25519.PrivateKey, authority Identity) (*Client, error) {
	if authority.Version != protocol.Version || len(authority.PublicKey) != ed25519.PublicKeySize || authority.ServiceID != protocol.KeyID(authority.PublicKey) || authority.HTTPSOrigin != client.endpoints.HTTPSOrigin || authority.WSSURL != client.endpoints.WSSURL || authority.STUNAddress != client.endpoints.STUNAddress {
		return nil, errors.New("p2p.invalid_service_identity")
	}
	if len(private) != ed25519.PrivateKeySize || !private.Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(device.PublicKey)) || !protocol.ValidID(device.DeviceID) || !protocol.ValidID(device.UserID) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	certificate, err := x509.ParseCertificate(device.Certificate)
	if err != nil {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	ca, err := x509.ParseCertificate(authority.Certificate)
	if err != nil || !ca.IsCA || ca.CheckSignatureFrom(ca) != nil {
		return nil, errors.New("p2p.invalid_service_identity")
	}
	caPublic, ok := ca.PublicKey.(ed25519.PublicKey)
	if !ok || !caPublic.Equal(ed25519.PublicKey(authority.PublicKey)) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	if _, err = certificate.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil || certificate.Subject.CommonName != device.DeviceID {
		return nil, errors.New("p2p.invalid_device_certificate")
	}
	public, valid := certificate.PublicKey.(ed25519.PublicKey)
	if !valid || !public.Equal(ed25519.PublicKey(device.PublicKey)) {
		return nil, errors.New("p2p.identity_mismatch")
	}
	next, err := New(client.endpoints, client.transport.TLSClientConfig.RootCAs)
	if err != nil {
		return nil, err
	}
	next.transport.TLSClientConfig.Certificates = []tls.Certificate{{Certificate: [][]byte{device.Certificate}, PrivateKey: private}}
	next.deviceID = device.DeviceID
	return next, nil
}

func (client *Client) Identity(ctx context.Context, pinnedKey ed25519.PublicKey) (Identity, error) {
	nonce := protocol.NewID()
	var value Identity
	if err := client.call(ctx, "POST", "/v1/identity", "", struct {
		Nonce string `json:"nonce"`
	}{nonce}, &value); err != nil {
		return value, err
	}
	if value.Version != protocol.Version || len(value.PublicKey) != ed25519.PublicKeySize || value.Nonce != nonce || value.ServiceID != protocol.KeyID(value.PublicKey) || value.HTTPSOrigin != client.endpoints.HTTPSOrigin || value.WSSURL != client.endpoints.WSSURL || value.STUNAddress != client.endpoints.STUNAddress {
		return Identity{}, errors.New("p2p.identity_mismatch")
	}
	if pinnedKey != nil && !pinnedKey.Equal(ed25519.PublicKey(value.PublicKey)) {
		return Identity{}, errors.New("p2p.identity_mismatch")
	}
	data, err := json.Marshal([]any{"dshker.service.v1", value.Version, value.ServiceID, value.PublicKey, value.Certificate, value.Nonce, value.HTTPSOrigin, value.WSSURL, value.STUNAddress})
	signature, decodeErr := base64.RawURLEncoding.DecodeString(value.Signature)
	if err != nil || decodeErr != nil || !ed25519.Verify(value.PublicKey, data, signature) {
		return Identity{}, errors.New("p2p.identity_mismatch")
	}
	ca, err := x509.ParseCertificate(value.Certificate)
	if err != nil || !ca.IsCA || ca.CheckSignatureFrom(ca) != nil {
		return Identity{}, errors.New("p2p.invalid_service_identity")
	}
	public, valid := ca.PublicKey.(ed25519.PublicKey)
	if !valid || !public.Equal(ed25519.PublicKey(value.PublicKey)) {
		return Identity{}, errors.New("p2p.identity_mismatch")
	}
	return value, nil
}

func (client *Client) call(ctx context.Context, method, path, token string, body, target any) error {
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil || len(data) > protocol.MaxControlBytes {
			return errors.New("p2p.protocol_limit")
		}
		payload = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, client.endpoints.HTTPSOrigin+path, payload)
	if err != nil {
		return errors.New("p2p.invalid_request")
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.http.Do(request)
	if err != nil {
		return errors.New("p2p.server_unavailable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, protocol.MaxControlBytes+1))
	if err != nil || len(data) > protocol.MaxControlBytes {
		return errors.New("p2p.protocol_limit")
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Code string `json:"code"`
		}
		if protocol.Decode(data, &failure) != nil || !strings.HasPrefix(failure.Code, "p2p.") || strings.ContainsAny(failure.Code, " \r\n\t") {
			return errors.New("p2p.invalid_server_response")
		}
		return errors.New(failure.Code)
	}
	return decodeResponse(data, target)
}

func decodeResponse(data []byte, target any) error {
	value := reflect.ValueOf(target).Elem()
	if value.Kind() != reflect.Slice {
		return protocol.Decode(data, target)
	}
	var entries []json.RawMessage
	if json.Unmarshal(data, &entries) != nil || entries == nil {
		return errors.New("p2p.invalid_server_response")
	}
	result := reflect.MakeSlice(value.Type(), 0, len(entries))
	for _, entry := range entries {
		item := reflect.New(value.Type().Elem())
		if err := protocol.Decode(entry, item.Interface()); err != nil {
			return err
		}
		result = reflect.Append(result, item.Elem())
	}
	value.Set(result)
	return nil
}
