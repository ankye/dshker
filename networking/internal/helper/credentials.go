package helper

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"strings"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// credentialPrefix names the reserved secrets holding one account's enrolled
// device credential, one entry per coordination service.
//
// The device key beside it (machine.device-key) is the machine's identity and is
// shared by every account; this record is what that identity was enrolled as with
// one service: the id the coordinator issued, the certificate it signed, and the
// account the enrollment belongs to.
const credentialPrefix = "account.credential."

// credentialIndexName lists the services the core holds a credential for.
//
// The providers store values by name and cannot enumerate them — the macOS
// Keychain in particular is deliberately not listable — so a headless start has no
// way to discover its own records without this. It used to read the catalog's
// service rows instead, but those are written by the desktop shell: a machine that
// has only ever run headless has none, so the restore found nothing to do on
// exactly the machines it exists for.
const credentialIndexName = "account.credential-index"

// storedCredential is the core's own record of an enrolled device.
//
// Enrollment already produced every field here inside the core, but the core used
// to hand them all to the caller and keep none: the desktop shell held the only
// copy, encrypted with a key only Electron can use. One identity was therefore
// owned by two processes — the private key by the core, everything needed to use
// it by the shell — and a core without a desktop attached could not act as the
// device it already had the key for. `dshkerd serve` came up, answered RPC, and
// never reached the coordinator, because nothing could tell it who it was.
type storedCredential struct {
	Version   int    `json:"version"`
	ServiceID string `json:"serviceId"`
	// Endpoints is how the core reaches the coordinator this device is enrolled
	// with. It is part of the credential rather than read from the catalog because
	// the catalog's service rows are written by the desktop shell: a machine that
	// has only ever run headless has none, so a restore that depended on them could
	// never find the service it holds a credential for. With these here the record
	// is self-sufficient — it names the coordinator, the identity to pin, and the
	// device to be.
	Endpoints   controlplane.Endpoints `json:"endpoints"`
	ServiceKey  []byte                 `json:"serviceKey"`
	DeviceID    string                 `json:"deviceId"`
	UserID      string                 `json:"userId"`
	Name        string                 `json:"name"`
	PublicKey   []byte                 `json:"publicKey"`
	Certificate []byte                 `json:"certificate"`
	PrivateKey  []byte                 `json:"privateKey"`
}

// device rebuilds the control-plane record this credential enrolled.
func (stored storedCredential) device() controlplane.Device {
	return controlplane.Device{
		DeviceID:    stored.DeviceID,
		UserID:      stored.UserID,
		Name:        stored.Name,
		PublicKey:   stored.PublicKey,
		Certificate: stored.Certificate,
	}
}

// valid reports whether the record can be used to speak as the device.
//
// A partially written or foreign record is refused rather than repaired: acting
// as a device whose key does not match its certificate is what wedges a pair on
// an identity neither side recognizes.
func (stored storedCredential) valid() bool {
	if stored.Version != 1 || !protocol.ValidID(stored.ServiceID) || !protocol.ValidID(stored.DeviceID) {
		return false
	}
	// Without an origin to reach and a key to pin, the record cannot restore itself.
	if stored.Endpoints.HTTPSOrigin == "" || stored.Endpoints.WSSURL == "" || len(stored.ServiceKey) != 32 {
		return false
	}
	if len(stored.PrivateKey) != ed25519.PrivateKeySize || len(stored.Certificate) == 0 {
		return false
	}
	private := ed25519.PrivateKey(stored.PrivateKey)
	public, ok := private.Public().(ed25519.PublicKey)
	if !ok {
		return false
	}
	// The stored public key is redundant with the private one; a mismatch means the
	// record was assembled from two different identities.
	return string(public) == string(stored.PublicKey)
}

func credentialKey(serviceID string) string { return credentialPrefix + serviceID }

// SaveCredential records the enrolled device for one service in the core's own
// key store, making the core the owner of the whole identity rather than of half
// of it.
//
// It is called on the two paths that produce or receive a credential — completing
// an enrollment, and a desktop restoring one it still holds — so an existing
// installation converges on the first launch after updating without the user
// enrolling again.
func (host *Host) SaveCredential(serviceID string, device controlplane.Device, private ed25519.PrivateKey) error {
	host.mu.Lock()
	store := host.deviceKeys
	account := host.accounts[serviceID]
	host.mu.Unlock()
	// The endpoints and the pinned service key come from the account this device is
	// enrolled with, so the record can be restored without consulting anything the
	// shell owns.
	var endpoints controlplane.Endpoints
	var serviceKey []byte
	if account != nil {
		endpoints = account.endpoints
		serviceKey = account.identity.PublicKey
	}
	if store == nil {
		return errors.New("p2p.secret_provider_unavailable")
	}
	record := storedCredential{
		Version:     1,
		ServiceID:   serviceID,
		Endpoints:   endpoints,
		ServiceKey:  serviceKey,
		DeviceID:    device.DeviceID,
		UserID:      device.UserID,
		Name:        device.Name,
		PublicKey:   device.PublicKey,
		Certificate: device.Certificate,
		PrivateKey:  private,
	}
	if !record.valid() {
		return errors.New("p2p.invalid_device_state")
	}
	data, err := json.Marshal(record)
	if err != nil {
		return errors.New("p2p.invalid_device_state")
	}
	if err := store.Set(credentialKey(serviceID), data); err != nil {
		return errors.New("p2p.secret_provider_unavailable")
	}
	// The index is written after the record it names, so a crash between the two
	// leaves an unlisted record rather than a listed one that does not exist.
	if err := addCredentialIndex(store, serviceID); err != nil {
		return err
	}
	return nil
}

// credentialIndexRecord wraps the service list in an object.
//
// The shared decoder admits only JSON objects — it verifies the field set against
// the target type — so a bare array is refused as invalid. Storing the list bare
// made every index read fail, which silently left the machine with a recorded
// credential it never listed and therefore never restored.
type credentialIndexRecord struct {
	Version  int      `json:"version"`
	Services []string `json:"services"`
}

// credentialIndex reads the recorded service list, treating an absent or unusable
// index as empty: a machine with no records is the ordinary first-run state.
func credentialIndex(store secret.Store) []string {
	data, err := store.Get(credentialIndexName)
	if err != nil {
		return nil
	}
	var record credentialIndexRecord
	if protocol.DecodeExact(data, &record) != nil || record.Version != 1 {
		return nil
	}
	services := make([]string, 0, len(record.Services))
	for _, serviceID := range record.Services {
		if protocol.ValidID(serviceID) {
			services = append(services, serviceID)
		}
	}
	return services
}

// writeCredentialIndex publishes the list, which is the only way it is written.
func writeCredentialIndex(store secret.Store, services []string) error {
	data, err := json.Marshal(credentialIndexRecord{Version: 1, Services: services})
	if err != nil {
		return errors.New("p2p.invalid_device_state")
	}
	if err := store.Set(credentialIndexName, data); err != nil {
		return errors.New("p2p.secret_provider_unavailable")
	}
	return nil
}

func addCredentialIndex(store secret.Store, serviceID string) error {
	for _, existing := range credentialIndex(store) {
		if existing == serviceID {
			return nil
		}
	}
	return writeCredentialIndex(store, append(credentialIndex(store), serviceID))
}

func removeCredentialIndex(store secret.Store, serviceID string) error {
	listed := credentialIndex(store)
	next := make([]string, 0, len(listed))
	for _, existing := range listed {
		if existing != serviceID {
			next = append(next, existing)
		}
	}
	if len(next) == len(listed) {
		return nil
	}
	return writeCredentialIndex(store, next)
}

// RecordedCredentialServices lists the services the core holds a credential for.
func (host *Host) RecordedCredentialServices() []string {
	host.mu.Lock()
	store := host.deviceKeys
	host.mu.Unlock()
	if store == nil {
		return nil
	}
	return credentialIndex(store)
}

// LoadCredential reads the credential the core saved for one service.
//
// A missing record is reported as such, because on a machine that has not been
// enrolled — or has not yet been handed one by a desktop that still owns the only
// copy — there is nothing wrong: there is simply no device to act as yet.
func (host *Host) LoadCredential(serviceID string) (storedCredential, error) {
	host.mu.Lock()
	store := host.deviceKeys
	host.mu.Unlock()
	if store == nil {
		return storedCredential{}, secret.ErrMissing
	}
	data, err := store.Get(credentialKey(serviceID))
	if err != nil {
		if errors.Is(err, secret.ErrMissing) {
			return storedCredential{}, secret.ErrMissing
		}
		return storedCredential{}, errors.New("p2p.secret_provider_unavailable")
	}
	var record storedCredential
	if protocol.DecodeExact(data, &record) != nil || record.ServiceID != serviceID || !record.valid() {
		// A record this build cannot use is not an identity. Reporting it as absent
		// keeps the machine enrollable instead of failing every launch on a value
		// that no operation can repair.
		return storedCredential{}, secret.ErrMissing
	}
	return record, nil
}

// DeleteCredential forgets the credential for one service, so leaving a network
// or removing a service does not leave the core able to speak as a device the
// user retired.
func (host *Host) DeleteCredential(serviceID string) error {
	host.mu.Lock()
	store := host.deviceKeys
	host.mu.Unlock()
	if store == nil {
		return nil
	}
	if err := store.Delete(credentialKey(serviceID)); err != nil && !errors.Is(err, secret.ErrMissing) {
		return errors.New("p2p.secret_provider_unavailable")
	}
	return removeCredentialIndex(store, serviceID)
}

// credentialServiceID reports the service a reserved credential key names.
func credentialServiceID(key string) (string, bool) {
	if !strings.HasPrefix(key, credentialPrefix) {
		return "", false
	}
	serviceID := strings.TrimPrefix(key, credentialPrefix)
	if !protocol.ValidID(serviceID) {
		return "", false
	}
	return serviceID, true
}
