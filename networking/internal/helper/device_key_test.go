package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"testing"
)

func TestCSRUsesOriginalDeviceIdentity(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	created, err := host.Handle(context.Background(), "device.createKey", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(created)
	if err != nil {
		t.Fatal(err)
	}
	var key struct {
		PrivateKey []byte `json:"privateKey"`
		CSR        string `json:"csr"`
	}
	if json.Unmarshal(encoded, &key) != nil || len(key.PrivateKey) != 64 {
		t.Fatal("key response invalid")
	}
	public := ed25519.PrivateKey(key.PrivateKey).Public().(ed25519.PublicKey)
	checkCSR(t, key.CSR, public)
	request, err := json.Marshal(struct {
		PrivateKey []byte `json:"privateKey"`
	}{key.PrivateKey})
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		result, err := host.Handle(context.Background(), "device.createCSR", request)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		var record map[string]string
		if json.Unmarshal(encoded, &record) != nil || len(record) != 1 {
			t.Fatal("CSR response leaked extra fields")
		}
		checkCSR(t, record["csr"], public)
	}
}

func TestCSRRejectsInvalidKeyOrOperationState(t *testing.T) {
	host := New(context.Background())
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, 32))
	corrupted := append([]byte(nil), private...)
	corrupted[63] ^= 1
	for _, key := range [][]byte{nil, private[:32], corrupted} {
		request, _ := json.Marshal(map[string][]byte{"privateKey": key})
		if _, err := host.Handle(context.Background(), "device.createCSR", request); err == nil {
			t.Fatal("invalid key accepted")
		}
	}
	request, _ := json.Marshal(map[string]any{"privateKey": private, "extra": true})
	if _, err := host.Handle(context.Background(), "device.createCSR", request); err == nil {
		t.Fatal("unknown field accepted")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, method := range []string{"device.createKey", "device.createCSR"} {
		if _, err := host.Handle(cancelled, method, json.RawMessage(`{}`)); err == nil || err.Error() != "p2p.request_cancelled" {
			t.Fatal("cancelled key operation accepted")
		}
	}
	host.Close()
	for _, method := range []string{"device.createKey", "device.createCSR", "service.configure"} {
		if _, err := host.Handle(context.Background(), method, json.RawMessage(`{}`)); err == nil || err.Error() != "p2p.helper_unavailable" {
			t.Fatal("closed host accepted key operation")
		}
	}
}

func checkCSR(t *testing.T, encoded string, public ed25519.PublicKey) {
	t.Helper()
	block, rest := pem.Decode([]byte(encoded))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(rest) != 0 {
		t.Fatal("invalid CSR PEM")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		t.Fatal("CSR signature invalid")
	}
	actual, ok := csr.PublicKey.(ed25519.PublicKey)
	if !ok || !actual.Equal(public) {
		t.Fatal("CSR changed device identity")
	}
}
