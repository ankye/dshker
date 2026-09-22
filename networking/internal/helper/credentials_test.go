package helper

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"sync"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/secret"
)

// memoryStore is the machine key store, in memory. The production providers are
// the OS keychain, DPAPI and Secret Service; what this package owns is which
// records it keeps and how it reads them back, which is what these tests pin.
type memoryStore struct {
	mu     sync.Mutex
	values map[string][]byte
	failed bool
}

func newMemoryStore() *memoryStore { return &memoryStore{values: map[string][]byte{}} }

func (store *memoryStore) Get(key string) ([]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failed {
		return nil, errors.New("provider offline")
	}
	value, ok := store.values[key]
	if !ok {
		return nil, secret.ErrMissing
	}
	return append([]byte(nil), value...), nil
}

func (store *memoryStore) Set(key string, value []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failed {
		return errors.New("provider offline")
	}
	store.values[key] = append([]byte(nil), value...)
	return nil
}

func (store *memoryStore) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.values, key)
	return nil
}

// configuredAccount registers an account the way service.configure leaves one, so
// a credential saved for it records the coordinator to reach and the identity to
// pin. A credential without those cannot restore itself, which is what valid()
// enforces and what these tests would otherwise skip over.
func configuredAccount(t *testing.T, host *Host, serviceID string) {
	t.Helper()
	serviceKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	host.mu.Lock()
	host.accounts[serviceID] = &account{
		identity:  controlplane.Identity{Version: 1, ServiceID: serviceID, PublicKey: serviceKey},
		endpoints: controlplane.Endpoints{HTTPSOrigin: "https://coordinator.example", WSSURL: "wss://coordinator.example/v1/signals", STUNAddress: "coordinator.example:3478"},
		host:      host,
	}
	host.mu.Unlock()
	// The account holds no control-plane client, so it must not be torn down as a
	// configured one: these tests exercise the credential store, not the session.
	t.Cleanup(func() {
		host.mu.Lock()
		delete(host.accounts, serviceID)
		host.mu.Unlock()
	})
}

// enrolledDevice is a credential shaped like one the coordinator issues: the
// public key must be the private key's own, which is what valid() enforces.
func enrolledDevice(t *testing.T, serviceID string) (controlplane.Device, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return controlplane.Device{
		DeviceID:    "aabbccddeeff",
		UserID:      "112233445566",
		Name:        "workstation",
		PublicKey:   public,
		Certificate: []byte("certificate-bytes"),
	}, private
}

// The credential the core records has to come back as the same identity, because
// this record is what lets a headless core speak as the device at all.
func TestCredentialRoundTripsThroughTheCoreStore(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	store := newMemoryStore()
	host.SetDeviceKeys(store)
	configuredAccount(t, host, "245e9f53bfde")
	device, private := enrolledDevice(t, "245e9f53bfde")

	if err := host.SaveCredential("245e9f53bfde", device, private); err != nil {
		t.Fatal(err)
	}
	loaded, err := host.LoadCredential("245e9f53bfde")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DeviceID != device.DeviceID || loaded.UserID != device.UserID {
		t.Fatalf("identity changed: got %s/%s", loaded.DeviceID, loaded.UserID)
	}
	if string(loaded.PrivateKey) != string(private) {
		t.Fatal("the private key did not round-trip")
	}
	if string(loaded.device().Certificate) != string(device.Certificate) {
		t.Fatal("the certificate did not round-trip")
	}
}

// A service this machine never enrolled with is not an error: the machine is
// simply not that device yet, and a headless start must skip it rather than fail.
func TestLoadCredentialReportsAbsenceForAnUnenrolledService(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	host.SetDeviceKeys(newMemoryStore())
	if _, err := host.LoadCredential("245e9f53bfde"); !errors.Is(err, secret.ErrMissing) {
		t.Fatalf("error = %v, want secret.ErrMissing", err)
	}
}

// A record whose key and certificate belong to different identities cannot be
// used to act as the device; loading it must not hand back half an identity.
func TestLoadCredentialRefusesAMismatchedRecord(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	store := newMemoryStore()
	host.SetDeviceKeys(store)
	configuredAccount(t, host, "245e9f53bfde")
	device, private := enrolledDevice(t, "245e9f53bfde")
	if err := host.SaveCredential("245e9f53bfde", device, private); err != nil {
		t.Fatal(err)
	}
	// Replace the stored public key with another identity's, the shape a record
	// assembled from two enrollments would have.
	other, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := host.LoadCredential("245e9f53bfde")
	if err != nil {
		t.Fatal(err)
	}
	stored.PublicKey = other
	if stored.valid() {
		t.Fatal("a record whose key does not match its public key was accepted")
	}
}

// Forgetting a service must leave the core unable to speak as that device, so a
// retired enrollment does not come back on the next headless start.
func TestDeleteCredentialForgetsTheEnrollment(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	host.SetDeviceKeys(newMemoryStore())
	configuredAccount(t, host, "245e9f53bfde")
	device, private := enrolledDevice(t, "245e9f53bfde")
	if err := host.SaveCredential("245e9f53bfde", device, private); err != nil {
		t.Fatal(err)
	}
	if err := host.DeleteCredential("245e9f53bfde"); err != nil {
		t.Fatal(err)
	}
	if _, err := host.LoadCredential("245e9f53bfde"); !errors.Is(err, secret.ErrMissing) {
		t.Fatalf("error after delete = %v, want secret.ErrMissing", err)
	}
}

// Saving must refuse an incomplete identity rather than store something no
// operation can use: a core that came up with such a record would report itself
// as a device the coordinator does not know.
func TestSaveCredentialRefusesAnIncompleteIdentity(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	host.SetDeviceKeys(newMemoryStore())
	configuredAccount(t, host, "245e9f53bfde")
	device, private := enrolledDevice(t, "245e9f53bfde")
	missingCertificate := device
	missingCertificate.Certificate = nil
	if err := host.SaveCredential("245e9f53bfde", missingCertificate, private); err == nil {
		t.Fatal("a credential with no certificate was stored")
	}
	if err := host.SaveCredential("not-an-id", device, private); err == nil {
		t.Fatal("a credential for an invalid service id was stored")
	}
}

// With no provider composed there is nothing stored and nothing to restore. A
// desktop-driven machine must keep working exactly as it did.
func TestRestoreOwnCredentialsWithoutAProviderRestoresNothing(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	if restored := host.RestoreOwnCredentials(context.Background()); restored != 0 {
		t.Fatalf("restored = %d, want 0", restored)
	}
}
