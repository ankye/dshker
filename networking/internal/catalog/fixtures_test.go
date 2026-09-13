package catalog

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"testing"
	"time"
)

// newService builds a service entry the strict parser accepts: a self-signed
// ed25519 CA whose key hashes to the service id.
func newService(t *testing.T, name string) Service {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	digest := sha256.Sum256(public)
	serviceID := hex.EncodeToString(digest[:])
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatalf("certificate: %v", err)
	}
	return Service{
		ServiceID:   serviceID,
		DisplayName: name,
		HTTPSOrigin: "https://coordinator.example:8443",
		WSSURL:      "wss://coordinator.example:8443/v1/signals",
		STUNAddress: "coordinator.example:3478",
		PublicKey:   base64.StdEncoding.EncodeToString(public),
		Certificate: base64.StdEncoding.EncodeToString(der),
	}
}

func newComputer(t *testing.T, service Service) Computer {
	t.Helper()
	local, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	remote, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	return Computer{
		ConnectionID:    randomID(t),
		ServiceID:       service.ServiceID,
		DisplayName:     "Work computer",
		PairID:          randomID(t),
		NetworkID:       randomID(t),
		LocalDeviceID:   randomID(t),
		RemoteDeviceID:  randomID(t),
		UserID:          randomID(t),
		LocalPublicKey:  base64.StdEncoding.EncodeToString(local),
		RemotePublicKey: base64.StdEncoding.EncodeToString(remote),
		PairRevision:    1,
		PairState:       "active",
	}
}

func randomID(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(buf)
}

func openStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return store
}
