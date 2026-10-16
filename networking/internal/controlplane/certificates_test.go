package controlplane

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

// This CA, key material and server exist only in tests. TLS verifies both the
// server and every offered client certificate; public recovery requests offer none.
type certificateTLSFixture struct {
	client    *Client
	authority Identity
	ca        *x509.Certificate
	caKey     ed25519.PrivateKey
	private   ed25519.PrivateKey
	device    Device
}

func newCertificateTLSFixture(t *testing.T, handler func(http.ResponseWriter, *http.Request)) *certificateTLSFixture {
	t.Helper()
	public, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: big.NewInt(100), Subject: pkix.Name{CommonName: "certificate test authority"}, NotBefore: now.Add(-48 * time.Hour), NotAfter: now.Add(90 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, public, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err = x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	_, serverKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverTemplate := &x509.Certificate{SerialNumber: big.NewInt(101), Subject: pkix.Name{CommonName: "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, ca, serverKey.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	server := httptest.NewUnstartedServer(http.HandlerFunc(handler))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{{Certificate: [][]byte{serverDER}, PrivateKey: serverKey}}, ClientCAs: roots, ClientAuth: tls.VerifyClientCertIfGiven}
	server.StartTLS()
	t.Cleanup(server.Close)
	endpoints := Endpoints{HTTPSOrigin: server.URL, WSSURL: strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals", STUNAddress: "127.0.0.1:3478"}
	client, err := New(endpoints, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{2}, ed25519.SeedSize))
	fixture := &certificateTLSFixture{client: client, ca: ca, caKey: caKey, private: private,
		authority: Identity{Version: protocol.Version, ServiceID: protocol.KeyID(public), PublicKey: public, Certificate: caDER, HTTPSOrigin: endpoints.HTTPSOrigin, WSSURL: endpoints.WSSURL, STUNAddress: endpoints.STUNAddress},
		device:    Device{DeviceID: "0123456789ab", UserID: "abcdef012345", PublicKey: private.Public().(ed25519.PublicKey), Name: "original machine"}}
	fixture.device.Certificate = fixture.issue(t, 1, nil)
	return fixture
}

func (fixture *certificateTLSFixture) issue(t *testing.T, serial int64, change func(*x509.Certificate)) []byte {
	t.Helper()
	leaf := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: fixture.device.DeviceID}, NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().Add(2 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	if change != nil {
		change(leaf)
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, fixture.ca, fixture.private.Public(), fixture.caKey)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func certificateError(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || err.Error() != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}

func certificateRequest(t *testing.T, writer http.ResponseWriter, request *http.Request, path string, target any) bool {
	t.Helper()
	if request.Method != http.MethodPost || request.URL.Path != path || request.Header.Get("Authorization") != "" || request.Header.Get("Content-Type") != "application/json" {
		t.Errorf("certificate request changed admission fields: %s %s, headers %v", request.Method, request.URL.Path, request.Header)
		writer.WriteHeader(http.StatusBadRequest)
		return false
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Errorf("certificate request invalid: %v", err)
		writer.WriteHeader(http.StatusBadRequest)
		return false
	}
	return true
}

func certificateCSR(t *testing.T, value string, public []byte) {
	t.Helper()
	block, rest := pem.Decode([]byte(value))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(rest) != 0 {
		t.Error("certificate request did not carry one PEM CSR")
		return
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		t.Error(err)
		return
	}
	key, valid := csr.PublicKey.(ed25519.PublicKey)
	if !valid || !bytes.Equal(key, public) || csr.CheckSignature() != nil {
		t.Error("certificate CSR did not preserve the signed original device key")
	}
}

func TestCertificateQueryGoldenAndInvalidInputs(t *testing.T) {
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))
	query, err := newCertificateQuery("fedcba987654", "0123456789ab", private, time.Unix(1792108800, 0))
	if err != nil {
		t.Fatal(err)
	}
	if query.ServiceID != "fedcba987654" || query.DeviceID != "0123456789ab" || query.IssuedAt != 1792108800 || base64.StdEncoding.EncodeToString(query.PublicKey) != "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=" || query.Signature != "58tfQo9gfJ7kwhvB6E1brkGgkoxVxE8NupyIo_MkSe2Cx14wBICmFQ-UwvT48wOdwxWhM0-Ik1gvVN8jSywcBg" {
		t.Fatalf("certificate query signature contract changed: %+v", query)
	}
	for _, entry := range []struct {
		name, service, device, code string
		key                         ed25519.PrivateKey
	}{
		{"missing_service", "", query.DeviceID, "p2p.invalid_request", private},
		{"invalid_device", query.ServiceID, "other-device", "p2p.invalid_request", private},
		{"missing_key", query.ServiceID, query.DeviceID, "p2p.invalid_request", nil},
		{"short_key", query.ServiceID, query.DeviceID, "p2p.invalid_request", private[:32]},
		{"inconsistent_key", query.ServiceID, query.DeviceID, "p2p.identity_mismatch", append(append(ed25519.PrivateKey(nil), private[:32]...), bytes.Repeat([]byte{0}, 32)...)},
	} {
		t.Run(entry.name, func(t *testing.T) {
			_, err := newCertificateQuery(entry.service, entry.device, entry.key, time.Now())
			certificateError(t, err, entry.code)
		})
	}
	if CertificateRenewalWindow != 7*24*time.Hour {
		t.Fatal("certificate renewal window differs from the server's seven-day contract")
	}
}

func TestCertificateValidationRejectsUntrustedOrInconsistentIdentity(t *testing.T) {
	fixture := newCertificateTLSFixture(t, nil)
	other := newCertificateTLSFixture(t, nil)
	for _, entry := range []struct {
		name, code string
		change     func(*Device, *ed25519.PrivateKey, *Identity)
	}{
		{"wrong_ca", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) { d.Certificate = other.device.Certificate }},
		{"wrong_cn", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.Subject.CommonName = "000000000001" })
		}},
		{"wrong_device", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) { d.DeviceID = "000000000001" }},
		{"wrong_private_key", "p2p.identity_mismatch", func(_ *Device, k *ed25519.PrivateKey, _ *Identity) {
			*k = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, 32))
		}},
		{"inconsistent_private_key", "p2p.identity_mismatch", func(_ *Device, k *ed25519.PrivateKey, _ *Identity) {
			*k = append(ed25519.PrivateKey(nil), (*k)...)
			(*k)[63] ^= 1
		}},
		{"wrong_public_key", "p2p.identity_mismatch", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) { d.PublicKey = bytes.Repeat([]byte{3}, 32) }},
		{"missing_private_key", "p2p.identity_mismatch", func(_ *Device, k *ed25519.PrivateKey, _ *Identity) { *k = nil }},
		{"invalid_user", "p2p.identity_mismatch", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) { d.UserID = "" }},
		{"missing_client_auth", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth} })
		}},
		{"any_usage_not_client_auth", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageAny} })
		}},
		{"future", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.NotBefore = time.Now().Add(time.Hour) })
		}},
		{"expired", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.NotAfter = time.Now().Add(-time.Hour) })
		}},
		{"invalid_interval", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.NotAfter = c.NotBefore })
		}},
		{"leaf_is_ca", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.IsCA = true; c.BasicConstraintsValid = true })
		}},
		{"malformed_leaf", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) { d.Certificate = []byte("malformed") }},
		{"invalid_signature", "p2p.invalid_device_certificate", func(d *Device, _ *ed25519.PrivateKey, _ *Identity) {
			d.Certificate = append([]byte(nil), d.Certificate...)
			d.Certificate[len(d.Certificate)-1] ^= 1
		}},
		{"malformed_authority", "p2p.invalid_service_identity", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) { a.Certificate = []byte("malformed") }},
		{"authority_key_binding", "p2p.identity_mismatch", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) {
			a.PublicKey = other.authority.PublicKey
			a.ServiceID = other.authority.ServiceID
		}},
		{"authority_service_id", "p2p.invalid_service_identity", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) { a.ServiceID = "000000000001" }},
		{"authority_endpoint", "p2p.invalid_service_identity", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) { a.HTTPSOrigin = "https://other.test" }},
		{"authority_signal", "p2p.invalid_service_identity", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) { a.WSSURL = "wss://other.test/v1/signals" }},
		{"authority_stun", "p2p.invalid_service_identity", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) { a.STUNAddress = "other.test:3478" }},
		{"authority_protocol", "p2p.invalid_service_identity", func(_ *Device, _ *ed25519.PrivateKey, a *Identity) { a.Version++ }},
	} {
		t.Run(entry.name, func(t *testing.T) {
			device, private, authority := fixture.device, fixture.private, fixture.authority
			entry.change(&device, &private, &authority)
			_, err := fixture.client.ValidateDevice(device, private, authority, false)
			certificateError(t, err, entry.code)
			if entry.name != "expired" {
				_, err = fixture.client.ValidateDevice(device, private, authority, true)
				certificateError(t, err, entry.code)
			}
		})
	}
	leaf, err := fixture.client.ValidateDevice(fixture.device, fixture.private, fixture.authority, false)
	if err != nil || leaf.SerialNumber.Int64() != 1 || leaf.Subject.CommonName != fixture.device.DeviceID {
		t.Fatalf("authentic current certificate rejected: %v", err)
	}
}

func TestCertificateAuthorityValidityAndTLSCallbackRefusals(t *testing.T) {
	fixture := newCertificateTLSFixture(t, nil)
	for _, name := range []string{"expired_ca", "future_ca", "not_ca", "invalid_self_signature"} {
		t.Run(name, func(t *testing.T) {
			ca := *fixture.ca
			switch name {
			case "expired_ca":
				ca.NotAfter = time.Now().Add(-time.Hour)
			case "future_ca":
				ca.NotBefore = time.Now().Add(time.Hour)
			case "not_ca":
				ca.IsCA = false
			}
			der, err := x509.CreateCertificate(rand.Reader, &ca, &ca, fixture.caKey.Public(), fixture.caKey)
			if err != nil {
				t.Fatal(err)
			}
			if name == "invalid_self_signature" {
				der[len(der)-1] ^= 1
			}
			authority := fixture.authority
			authority.Certificate = der
			for _, allowExpired := range []bool{false, true} {
				if _, err := fixture.client.ValidateDevice(fixture.device, fixture.private, authority, allowExpired); err == nil {
					t.Fatalf("invalid authority admitted with allowExpired=%v", allowExpired)
				}
			}
		})
	}
	for _, name := range []string{"missing", "missing_leaf", "expired", "future"} {
		t.Run("callback_"+name, func(t *testing.T) {
			client := &Client{}
			if name != "missing" {
				client.certificate = &tls.Certificate{}
			}
			if name == "expired" || name == "future" {
				client.certificate.Leaf = &x509.Certificate{NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
				if name == "expired" {
					client.certificate.Leaf.NotAfter = time.Now().Add(-time.Second)
				} else {
					client.certificate.Leaf.NotBefore = time.Now().Add(time.Hour)
				}
			}
			certificate, err := client.clientCertificate(nil)
			certificateError(t, err, "p2p.invalid_device_certificate")
			if certificate != nil {
				t.Fatal("invalid certificate escaped into a TLS handshake")
			}
		})
	}
}

func TestCertificateExpiredQueryAndRecoveryUsePublicTLS(t *testing.T) {
	var fixture *certificateTLSFixture
	var queried, recovered atomic.Int32
	var expired, renewed []byte
	requestID := "1234567890ab"
	fixture = newCertificateTLSFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.TLS == nil || len(request.TLS.PeerCertificates) != 0 {
			t.Error("expired query/recovery attempted device mTLS")
		}
		switch request.URL.Path {
		case "/v1/certificate-query":
			var query certificateQuery
			if !certificateRequest(t, writer, request, "/v1/certificate-query", &query) {
				return
			}
			message := "dshker.certificate-query.v1\n" + query.ServiceID + "\n" + query.DeviceID + "\n" + base64.RawURLEncoding.EncodeToString(query.PublicKey) + "\n" + strconv.FormatInt(query.IssuedAt, 10)
			signature, err := base64.RawURLEncoding.DecodeString(query.Signature)
			if query.ServiceID != fixture.authority.ServiceID || query.DeviceID != fixture.device.DeviceID || !bytes.Equal(query.PublicKey, fixture.device.PublicKey) || query.IssuedAt > time.Now().Unix() || time.Now().Unix()-query.IssuedAt >= 60 || err != nil || !ed25519.Verify(fixture.device.PublicKey, []byte(message), signature) {
				t.Error("query altered scope, original-key proof or timestamp")
			}
			queried.Add(1)
			device := fixture.device
			device.Certificate = expired
			_ = json.NewEncoder(writer).Encode(device)
		case "/v1/recover-certificate":
			var body struct {
				DeviceID  string `json:"deviceId"`
				RequestID string `json:"requestId"`
				CSR       string `json:"csr"`
				Token     string `json:"token"`
			}
			if !certificateRequest(t, writer, request, "/v1/recover-certificate", &body) {
				return
			}
			if body.DeviceID != fixture.device.DeviceID || body.RequestID != requestID || body.Token != "explicit-network-grant" {
				t.Errorf("recovery substituted original scope: %+v", body)
			}
			certificateCSR(t, body.CSR, fixture.device.PublicKey)
			recovered.Add(1)
			_ = json.NewEncoder(writer).Encode(map[string][]byte{"certificate": renewed})
		default:
			t.Errorf("unexpected certificate route %s", request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
		}
	})
	expired = fixture.issue(t, 1, func(c *x509.Certificate) { c.NotAfter = time.Now().Add(-time.Hour) })
	renewed = fixture.issue(t, 2, nil)
	readback, err := fixture.client.ReadCertificate(context.Background(), fixture.device.DeviceID, fixture.private, fixture.authority)
	if err != nil || !bytes.Equal(readback.Certificate, expired) || readback.DeviceID != fixture.device.DeviceID || readback.UserID != fixture.device.UserID || readback.Name != fixture.device.Name || !bytes.Equal(readback.PublicKey, fixture.device.PublicKey) {
		t.Fatalf("expired authenticated readback lost original identity: %+v, %v", readback, err)
	}
	if _, err = fixture.client.WithDevice(readback, fixture.private, fixture.authority); err == nil {
		t.Fatal("expired readback activated mTLS")
	}
	authenticated, err := fixture.client.WithDevice(fixture.device, fixture.private, fixture.authority)
	if err != nil {
		t.Fatal(err)
	}
	defer authenticated.Close()
	leaf, err := x509.ParseCertificate(expired)
	if err != nil {
		t.Fatal(err)
	}
	// Model an already-open client's credential aging past expiry. This immutable
	// test snapshot requires the same production callback refusal as elapsed time.
	authenticated.certificateMu.Lock()
	authenticated.certificate = &tls.Certificate{Certificate: [][]byte{expired}, PrivateKey: fixture.private, Leaf: leaf}
	authenticated.certificateMu.Unlock()
	err = authenticated.call(context.Background(), http.MethodPost, "/v1/renew-certificate", "", nil, &struct{}{})
	certificateError(t, err, "p2p.server_unavailable")
	if queried.Load() != 1 || recovered.Load() != 0 {
		t.Fatal("expired mTLS reached the certificate handler")
	}
	publicReadback, err := authenticated.ReadCertificate(context.Background(), fixture.device.DeviceID, fixture.private, fixture.authority)
	if err != nil || !reflect.DeepEqual(publicReadback, readback) {
		t.Fatalf("expired live client failed public readback: %+v %v", publicReadback, err)
	}
	result, err := authenticated.RecoverCertificate(context.Background(), readback, fixture.private, fixture.authority, requestID, "explicit-network-grant")
	if err != nil || !bytes.Equal(result.Certificate, renewed) {
		t.Fatalf("original-key recovery failed: %v", err)
	}
	readback.Certificate = renewed
	if !reflect.DeepEqual(result, readback) || queried.Load() != 2 || recovered.Load() != 1 {
		t.Fatalf("recovery altered device fields or repeated issuance: %+v queries=%d recovery=%d", result, queried.Load(), recovered.Load())
	}
	_, err = fixture.client.RecoverCertificate(context.Background(), readback, fixture.private, fixture.authority, requestID, "")
	certificateError(t, err, "p2p.invalid_request")
	if recovered.Load() != 1 {
		t.Fatal("missing recovery authorization reached the server")
	}
}

func TestCertificateRenewalRealTLSAndSameClientHotUpdate(t *testing.T) {
	var fixture *certificateTLSFixture
	var renewed []byte
	requestID := "1234567890ab"
	fixture = newCertificateTLSFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.TLS == nil || len(request.TLS.PeerCertificates) != 1 || len(request.TLS.VerifiedChains) != 1 {
			t.Error("renewal/handshake lacks verified device mTLS")
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		peer := request.TLS.PeerCertificates[0]
		if peer.Subject.CommonName != fixture.device.DeviceID || !peer.PublicKey.(ed25519.PublicKey).Equal(ed25519.PublicKey(fixture.device.PublicKey)) {
			t.Error("TLS authenticated another device or key")
		}
		if request.URL.Path == "/certificate-serial" {
			_ = json.NewEncoder(writer).Encode(map[string]int64{"serial": peer.SerialNumber.Int64()})
			return
		}
		var body struct {
			RequestID string `json:"requestId"`
			CSR       string `json:"csr"`
		}
		if !certificateRequest(t, writer, request, "/v1/renew-certificate", &body) {
			return
		}
		if body.RequestID != requestID || peer.SerialNumber.Int64() != 1 {
			t.Error("renewal did not use its original request id and current certificate")
		}
		certificateCSR(t, body.CSR, fixture.device.PublicKey)
		_ = json.NewEncoder(writer).Encode(map[string][]byte{"certificate": renewed})
	})
	renewed = fixture.issue(t, 2, nil)
	client, err := fixture.client.WithDevice(fixture.device, fixture.private, fixture.authority)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	result, err := client.RenewCertificate(context.Background(), fixture.device, fixture.private, fixture.authority, requestID)
	if err != nil || !bytes.Equal(result.Certificate, renewed) {
		t.Fatalf("renewal failed: %v", err)
	}
	want := fixture.device
	want.Certificate = renewed
	if !reflect.DeepEqual(result, want) {
		t.Fatal("renewal changed original device, user, key or name")
	}
	assertSerial := func(want int64) {
		t.Helper()
		var response struct {
			Serial int64 `json:"serial"`
		}
		if err := client.call(context.Background(), http.MethodGet, "/certificate-serial", "", nil, &response); err != nil || response.Serial != want {
			t.Fatalf("same-client TLS certificate serial = %d, want %d: %v", response.Serial, want, err)
		}
	}
	assertSerial(1)
	if err := client.UpdateCertificate(result, fixture.private, fixture.authority); err != nil {
		t.Fatal(err)
	}
	assertSerial(2)
	rejected := result
	rejected.Certificate = fixture.issue(t, 3, func(c *x509.Certificate) { c.NotAfter = time.Now().Add(-time.Hour) })
	certificateError(t, client.UpdateCertificate(rejected, fixture.private, fixture.authority), "p2p.invalid_device_certificate")
	assertSerial(2)
	_, err = fixture.client.RenewCertificate(context.Background(), fixture.device, fixture.private, fixture.authority, requestID)
	certificateError(t, err, "p2p.identity_mismatch")
}

func TestCertificateHotUpdateCopiesCallerOwnedCredentialBytes(t *testing.T) {
	fixture := newCertificateTLSFixture(t, nil)
	client, err := fixture.client.WithDevice(fixture.device, fixture.private, fixture.authority)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	device := fixture.device
	device.Certificate = fixture.issue(t, 2, nil)
	want := append([]byte(nil), device.Certificate...)
	private := append(ed25519.PrivateKey(nil), fixture.private...)
	if err := client.UpdateCertificate(device, private, fixture.authority); err != nil {
		t.Fatal(err)
	}
	device.Certificate[0] ^= 1
	private[0] ^= 1
	snapshot, err := client.clientCertificate(nil)
	if err != nil || !bytes.Equal(snapshot.Certificate[0], want) || !bytes.Equal(snapshot.PrivateKey.(ed25519.PrivateKey), fixture.private) || snapshot.Leaf.SerialNumber.Int64() != 2 {
		t.Fatal("TLS snapshot retained caller-owned mutable credential bytes")
	}
	other := fixture.device
	other.DeviceID = "000000000001"
	other.Certificate = fixture.issue(t, 3, func(c *x509.Certificate) { c.Subject.CommonName = other.DeviceID })
	certificateError(t, client.UpdateCertificate(other, fixture.private, fixture.authority), "p2p.identity_mismatch")
	snapshot, err = client.clientCertificate(nil)
	if err != nil || snapshot.Leaf.SerialNumber.Int64() != 2 || client.deviceID != fixture.device.DeviceID {
		t.Fatal("another device replaced the current client identity")
	}
}

func TestCertificateReadbackRejectsIdentityAndCertificateSubstitution(t *testing.T) {
	for _, name := range []string{"device", "public_key", "user", "certificate", "wrong_ca", "future", "usage", "unknown_field"} {
		t.Run(name, func(t *testing.T) {
			var response Device
			fixture := newCertificateTLSFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				if name == "unknown_field" {
					data, _ := json.Marshal(response)
					_, _ = w.Write(append(data[:len(data)-1], []byte(`,"unexpected":true}`)...))
					return
				}
				_ = json.NewEncoder(w).Encode(response)
			})
			response = fixture.device
			switch name {
			case "device":
				response.DeviceID = "000000000001"
			case "public_key":
				response.PublicKey = bytes.Repeat([]byte{3}, 32)
			case "user":
				response.UserID = ""
			case "certificate":
				response.Certificate = []byte("malformed")
			case "wrong_ca":
				other := newCertificateTLSFixture(t, nil)
				response.Certificate = other.device.Certificate
			case "future":
				response.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.NotBefore = time.Now().Add(time.Hour) })
			case "usage":
				response.Certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth} })
			}
			result, err := fixture.client.ReadCertificate(context.Background(), fixture.device.DeviceID, fixture.private, fixture.authority)
			code := "p2p.invalid_device_certificate"
			if name == "device" || name == "public_key" || name == "user" {
				code = "p2p.identity_mismatch"
			} else if name == "unknown_field" {
				code = "p2p.invalid_fields"
			}
			certificateError(t, err, code)
			if !reflect.DeepEqual(result, Device{}) {
				t.Fatalf("untrusted readback escaped validation: %+v %v", result, err)
			}
		})
	}
}

func TestCertificateRenewalRejectsUntrustedIssuedCertificates(t *testing.T) {
	for _, name := range []string{"malformed", "expired", "wrong_cn", "wrong_ca", "wrong_key"} {
		t.Run(name, func(t *testing.T) {
			var certificate []byte
			fixture := newCertificateTLSFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string][]byte{"certificate": certificate})
			})
			switch name {
			case "malformed":
				certificate = []byte("malformed")
			case "expired":
				certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.NotAfter = time.Now().Add(-time.Hour) })
			case "wrong_cn":
				certificate = fixture.issue(t, 2, func(c *x509.Certificate) { c.Subject.CommonName = "000000000001" })
			case "wrong_ca":
				certificate = newCertificateTLSFixture(t, nil).device.Certificate
			case "wrong_key":
				other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, 32))
				template := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: fixture.device.DeviceID}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
				var err error
				certificate, err = x509.CreateCertificate(rand.Reader, template, fixture.ca, other.Public(), fixture.caKey)
				if err != nil {
					t.Fatal(err)
				}
			}
			client, err := fixture.client.WithDevice(fixture.device, fixture.private, fixture.authority)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			result, err := client.RenewCertificate(context.Background(), fixture.device, fixture.private, fixture.authority, "1234567890ab")
			code := "p2p.invalid_device_certificate"
			if name == "wrong_key" {
				code = "p2p.identity_mismatch"
			}
			certificateError(t, err, code)
			if !reflect.DeepEqual(result, Device{}) {
				t.Fatalf("untrusted issuance activated: %+v %v", result, err)
			}
			recovery, err := fixture.client.RecoverCertificate(context.Background(), fixture.device, fixture.private, fixture.authority, "1234567890ab", "explicit-network-grant")
			certificateError(t, err, code)
			if !reflect.DeepEqual(recovery, Device{}) {
				t.Fatalf("untrusted recovery activated: %+v %v", recovery, err)
			}
			snapshot, err := client.clientCertificate(nil)
			if err != nil || snapshot.Leaf.SerialNumber.Int64() != 1 || !bytes.Equal(snapshot.Certificate[0], fixture.device.Certificate) {
				t.Fatal("rejected issuance replaced the installed certificate")
			}
		})
	}
}

func TestCertificateHotUpdateKeepsActiveHTTPAndSignalsUnderRace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var fixture *certificateTLSFixture
	active := make(chan struct{})
	release := make(chan struct{})
	connections := make(chan *websocket.Conn, 1)
	fixture = newCertificateTLSFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 {
			t.Error("active channel lost authenticated identity")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		serial := r.TLS.PeerCertificates[0].SerialNumber.Int64()
		switch r.URL.Path {
		case "/active":
			_, _ = w.Write([]byte(`{"serial":`))
			w.(http.Flusher).Flush()
			close(active)
			select {
			case <-release:
				_, _ = fmt.Fprintf(w, "%d}", serial)
			case <-ctx.Done():
			}
		case "/v1/signals":
			connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"dshker.signal.v1"}})
			if err != nil {
				return
			}
			defer connection.CloseNow()
			ready, _ := json.Marshal(map[string]any{"type": "ready", "version": protocol.Version, "deviceId": fixture.device.DeviceID})
			if connection.Write(ctx, websocket.MessageText, ready) != nil {
				return
			}
			connections <- connection
			_, _, _ = connection.Read(ctx)
		case "/v1/heartbeat":
			_ = json.NewEncoder(w).Encode(map[string]any{"deviceId": fixture.device.DeviceID, "at": time.Now().Unix()})
		case "/serial":
			_ = json.NewEncoder(w).Encode(map[string]int64{"serial": serial})
		default:
			http.NotFound(w, r)
		}
	})
	client, err := fixture.client.WithDevice(fixture.device, fixture.private, fixture.authority)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	signals, err := client.Subscribe(ctx, fixture.device.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	defer signals.Close()
	connection := <-connections
	activeResult := make(chan error, 1)
	go func() {
		var result struct {
			Serial int64 `json:"serial"`
		}
		err := client.call(ctx, http.MethodGet, "/active", "", nil, &result)
		if err == nil && result.Serial != 1 {
			err = fmt.Errorf("active TLS identity changed: serial %d", result.Serial)
		}
		activeResult <- err
	}()
	select {
	case <-active:
	case <-ctx.Done():
		t.Fatal("active TLS request never opened")
	}
	renewed := fixture.device
	renewed.Certificate = fixture.issue(t, 2, nil)
	var work sync.WaitGroup
	for range 4 {
		work.Go(func() {
			for range 10 {
				var result struct {
					Serial int64 `json:"serial"`
				}
				if err := client.call(ctx, http.MethodGet, "/serial", "", nil, &result); err != nil || (result.Serial != 1 && result.Serial != 2) {
					t.Errorf("concurrent TLS request lost certificate: %+v %v", result, err)
				}
			}
		})
	}
	for range 20 {
		if err := client.UpdateCertificate(renewed, fixture.private, fixture.authority); err != nil {
			t.Fatal(err)
		}
	}
	work.Wait()
	if err := client.UpdateCertificate(renewed, fixture.private, fixture.authority); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-activeResult; err != nil {
		t.Fatalf("closing idle connections interrupted active HTTP: %v", err)
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"revoked","pairId":"fedcba987654","revision":9}`)); err != nil {
		t.Fatalf("certificate update closed signalling channel: %v", err)
	}
	select {
	case event := <-signals.Events():
		if event.Type != "revoked" || event.PairID != "fedcba987654" || event.Revision != 9 {
			t.Fatalf("active subscription lost event identity: %+v", event)
		}
	case <-ctx.Done():
		t.Fatal("original active subscription stopped delivering events")
	}
	if signals.Err() != nil || client.deviceID != fixture.device.DeviceID {
		t.Fatal("hot update changed client ownership or terminated signalling")
	}
	var final struct {
		Serial int64 `json:"serial"`
	}
	if err := client.call(ctx, http.MethodGet, "/serial", "", nil, &final); err != nil || final.Serial != 2 {
		t.Fatalf("future handshake retained old certificate: %+v %v", final, err)
	}
}
