package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestLoadRoots refuses anything that is not a PEM bundle of certificates,
// because the caller asked for these anchors specifically and a silent fallback
// to system roots would connect to a server the operator did not configure.
func TestLoadRoots(t *testing.T) {
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "roots-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(good, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	roots, err := loadRoots(good)
	if err != nil || roots == nil {
		t.Fatalf("loadRoots(good) = %v, %v", roots, err)
	}

	empty := filepath.Join(t.TempDir(), "empty.pem")
	if err := os.WriteFile(empty, []byte("not a certificate\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"a missing file":       filepath.Join(t.TempDir(), "absent.pem"),
		"a file without certs": empty,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := loadRoots(path); err == nil {
				t.Fatalf("loadRoots(%s) was accepted", path)
			}
		})
	}
}
