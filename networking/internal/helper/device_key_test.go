package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"testing"

	"github.com/ankye/dshker/networking/internal/secret"
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

// memoryDeviceKeys is the machine's own key store in tests.
type memoryDeviceKeys struct {
	values map[string][]byte
}

func (store *memoryDeviceKeys) Get(key string) ([]byte, error) {
	if value, ok := store.values[key]; ok {
		return append([]byte(nil), value...), nil
	}
	return nil, secret.ErrMissing
}
func (store *memoryDeviceKeys) Set(key string, value []byte) error {
	store.values[key] = append([]byte(nil), value...)
	return nil
}
func (store *memoryDeviceKeys) Delete(key string) error { delete(store.values, key); return nil }

func createdKey(t *testing.T, host *Host) ed25519.PrivateKey {
	t.Helper()
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
	}
	if json.Unmarshal(encoded, &key) != nil || len(key.PrivateKey) != ed25519.PrivateKeySize {
		t.Fatal("key response invalid")
	}
	return ed25519.PrivateKey(key.PrivateKey)
}

// The device identity belongs to the machine, not to an enrollment: every
// registration, every network and every later re-enrollment must present the
// same one. Minting a fresh key per enrollment is what turned a re-enrollment
// into a new device, leaving pairs, pins and catalog rows pointing at an
// identity nobody used any more.
func TestMachineKeepsOneDeviceIdentityAcrossEnrollments(t *testing.T) {
	keys := &memoryDeviceKeys{values: map[string][]byte{}}
	host := New(context.Background())
	host.SetDeviceKeys(keys)
	defer host.Close()

	first := createdKey(t, host)
	if second := createdKey(t, host); !first.Equal(second) {
		t.Fatal("a second enrollment minted a new device identity")
	}
	// A restarted core, with the same data root, is still the same machine.
	restarted := New(context.Background())
	restarted.SetDeviceKeys(keys)
	defer restarted.Close()
	if afterRestart := createdKey(t, restarted); !first.Equal(afterRestart) {
		t.Fatal("restarting the core changed the machine identity")
	}
	// The identity is machine state, never a credential of one account: the key
	// is the only thing stored, under a reserved name.
	if len(keys.values) != 1 {
		t.Fatalf("machine key store holds %d entries, want 1", len(keys.values))
	}
	stored, ok := keys.values[machineDeviceKeyName]
	if !ok || !bytes.Equal(stored, first) {
		t.Fatal("the machine key was not persisted under its reserved name")
	}
}

// A corrupt entry is an entry that cannot sign, not an identity to hand out.
func TestMachineReplacesACorruptDeviceKey(t *testing.T) {
	keys := &memoryDeviceKeys{values: map[string][]byte{machineDeviceKeyName: []byte("short")}}
	host := New(context.Background())
	host.SetDeviceKeys(keys)
	defer host.Close()

	key := createdKey(t, host)
	if len(key) != ed25519.PrivateKeySize {
		t.Fatal("corrupt machine key was handed out")
	}
	if !bytes.Equal(keys.values[machineDeviceKeyName], key) {
		t.Fatal("the replacement key was not persisted")
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
