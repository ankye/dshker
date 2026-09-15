package helper

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// The rules below are the ones the shell used to apply when it recorded the
// coordinator's pairs, moved to where the pairs are read. They are tested against a
// real catalog store, because the interesting half is what that store's transition
// guard accepts: dropping an active computer is refused, and reviving a revoked one
// is refused too.

func newKey(t *testing.T) []byte {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(public)
}

// plantedPair is one pair between this machine and a remote device. Both ends carry
// the same user id, which is what the coordinator's own identity answer requires.
func plantedPair(t *testing.T, localDeviceID string, userID string, localKey []byte, remoteName string, networkID string) (controlplane.PairIdentity, controlplane.PairDeviceIdentity) {
	t.Helper()
	remote := controlplane.PairDeviceIdentity{
		DeviceID:  protocol.NewID(),
		UserID:    userID,
		PublicKey: newKey(t),
		Name:      remoteName,
	}
	return controlplane.PairIdentity{
		Pair: controlplane.Pair{
			PairID:    protocol.NewID(),
			NetworkID: networkID,
			Initiator: localDeviceID,
			Target:    remote.DeviceID,
			State:     "active",
			Revision:  3,
		},
		Initiator: controlplane.PairDeviceIdentity{
			DeviceID:  localDeviceID,
			UserID:    userID,
			PublicKey: localKey,
			Name:      "laptop",
		},
		Target: remote,
	}, remote
}

// catalogService is a coordinator entry the record accepts: a self-signed ed25519
// CA whose key id is the service id, which is what the catalog validates against.
func catalogService(t *testing.T) catalog.Service {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "coordinator"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(public)
	return catalog.Service{
		ServiceID:   hex.EncodeToString(digest[:6]),
		DisplayName: "Home",
		HTTPSOrigin: "https://peer.example",
		WSSURL:      "wss://peer.example/v1/signals",
		STUNAddress: "peer.example:3478",
		PublicKey:   encodeKey(public),
		Certificate: base64.StdEncoding.EncodeToString(der),
	}
}

// openCatalog is a real store, so every record written here passes the same
// validation and transition rules the running core applies. The service is
// registered first, because a computer is only readable through its service entry.
func openCatalog(t *testing.T) (*catalog.Store, string) {
	t.Helper()
	store, err := catalog.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := store.Enable()
	if err != nil {
		t.Fatal(err)
	}
	service := catalog.Service(catalogService(t))
	record := enabled.Record
	record.Services = []catalog.Service{service}
	if _, err := store.Commit(enabled.Revision, record); err != nil {
		t.Fatal(err)
	}
	return store, service.ServiceID
}

// registerService adds one more coordinator entry, for a test that needs a row
// belonging to a service the pass under test does not rewrite.
func registerService(t *testing.T, store *catalog.Store) string {
	t.Helper()
	saved := inspect(t, store)
	service := catalogService(t)
	record := saved.Record
	record.Services = append(record.Services, service)
	if _, err := store.Commit(saved.Revision, record); err != nil {
		t.Fatal(err)
	}
	return service.ServiceID
}

func inspect(t *testing.T, store *catalog.Store) catalog.Snapshot {
	t.Helper()
	snapshot, err := store.Inspect()
	if err != nil || snapshot == nil {
		t.Fatalf("inspect: %+v %v", snapshot, err)
	}
	return *snapshot
}

// apply runs one whole pass: plan, then the commits the plan needs.
func apply(t *testing.T, store *catalog.Store, serviceID string, local localMember, members []controlplane.PairIdentity) string {
	t.Helper()
	saved := inspect(t, store)
	revision, err := recordPlan(store, saved, planMembers(saved, serviceID, local, members))
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	return revision
}

// A computer exists as soon as the coordinator authorizes it, instead of when a
// page that reads the pairs happens to open.
func TestPlanMembersRecordsAnAuthorizedPair(t *testing.T) {
	store, serviceID := openCatalog(t)
	key := newKey(t)
	local := localMember{deviceID: protocol.NewID(), publicKey: key}
	// serviceID comes from the catalog fixture above.
	networkID := protocol.NewID()
	identity, remote := plantedPair(t, local.deviceID, protocol.NewID(), key, "studio", networkID)

	apply(t, store, serviceID, local, []controlplane.PairIdentity{identity})

	computers := inspect(t, store).Record.Computers
	if len(computers) != 1 {
		t.Fatalf("computers = %+v", computers)
	}
	recorded := computers[0]
	if recorded.ConnectionID != remote.DeviceID || recorded.PairID != remote.DeviceID {
		t.Errorf("connection id = %q pair id = %q, want the remote device id %q", recorded.ConnectionID, recorded.PairID, remote.DeviceID)
	}
	if recorded.DisplayName != "studio" || recorded.PairState != "active" || recorded.PairRevision != 3 {
		t.Errorf("recorded = %+v", recorded)
	}
	if recorded.NetworkID != networkID || recorded.LocalDeviceID != local.deviceID || recorded.RemoteDeviceID != remote.DeviceID {
		t.Errorf("identities = %+v", recorded)
	}
	if recorded.UserID != identity.Initiator.UserID {
		t.Errorf("user id = %q, want the pair's own answer %q", recorded.UserID, identity.Initiator.UserID)
	}
	if recorded.RemotePublicKey == "" || recorded.RemotePublicKey == recorded.LocalPublicKey {
		t.Errorf("keys = %+v", recorded)
	}
}

// A pair the coordinator no longer carries is evidence the authorization is gone.
// Dropping the row outright is what the guard refuses, so it is recorded as
// revoked, and the pass after that drops the revoked row instead of accumulating it
// forever.
func TestPlanMembersRevokesAndThenDropsAMissingPair(t *testing.T) {
	store, serviceID := openCatalog(t)
	key := newKey(t)
	local := localMember{deviceID: protocol.NewID(), publicKey: key}
	// serviceID comes from the catalog fixture above.
	identity, _ := plantedPair(t, local.deviceID, protocol.NewID(), key, "studio", protocol.NewID())

	apply(t, store, serviceID, local, []controlplane.PairIdentity{identity})
	apply(t, store, serviceID, local, nil)

	revoked := inspect(t, store).Record.Computers
	if len(revoked) != 1 || revoked[0].PairState != "revoked" {
		t.Fatalf("computers = %+v, want one revoked row", revoked)
	}

	apply(t, store, serviceID, local, nil)
	if remaining := inspect(t, store).Record.Computers; len(remaining) != 0 {
		t.Fatalf("computers = %+v, want the revoked row gone", remaining)
	}
}

// The same two devices pairing again, or a network being rejoined, is a row the
// coordinator authorizes a second time. The catalog refuses to take a revoked
// computer back to active, so the revoked row has to be retired in its own commit
// first — the step that used to wedge both machines on each other's old identity.
func TestPlanMembersRetiresARevokedRowBeforeRecordingItAgain(t *testing.T) {
	store, serviceID := openCatalog(t)
	key := newKey(t)
	local := localMember{deviceID: protocol.NewID(), publicKey: key}
	// serviceID comes from the catalog fixture above.
	identity, _ := plantedPair(t, local.deviceID, protocol.NewID(), key, "studio", protocol.NewID())

	apply(t, store, serviceID, local, []controlplane.PairIdentity{identity})
	apply(t, store, serviceID, local, nil)
	if state := inspect(t, store).Record.Computers[0].PairState; state != "revoked" {
		t.Fatalf("state = %q, want revoked", state)
	}

	// One commit that revives the row is exactly what the guard exists to refuse.
	saved := inspect(t, store)
	revived := saved.Record
	revived.Computers = planMembers(saved, serviceID, local, []controlplane.PairIdentity{identity}).final
	if _, err := store.Commit(saved.Revision, revived); err == nil {
		t.Fatal("the guard must refuse reviving a revoked computer in one commit")
	}

	// The retirement step makes it legal: the revoked row goes first, and the new
	// authorization is recorded against the revision that commit produced.
	apply(t, store, serviceID, local, []controlplane.PairIdentity{identity})
	computers := inspect(t, store).Record.Computers
	if len(computers) != 1 || computers[0].PairState != "active" {
		t.Fatalf("computers = %+v, want the connection active again", computers)
	}
}

// A record naming this machine as its own peer survives every rewrite because it
// belongs to the service being rewritten, and a pair whose local side is not this
// machine's key is not this machine's authorization at all.
func TestPlanMembersDropsASelfRowAndAForeignLocalKey(t *testing.T) {
	store, serviceID := openCatalog(t)
	key := newKey(t)
	local := localMember{deviceID: protocol.NewID(), publicKey: key}
	// serviceID comes from the catalog fixture above.
	userID := protocol.NewID()

	// The pair claims a local side this machine does not hold the key for.
	impostor, _ := plantedPair(t, local.deviceID, userID, newKey(t), "studio", protocol.NewID())
	// And one that names this machine at both ends.
	self, _ := plantedPair(t, local.deviceID, userID, key, "self", protocol.NewID())
	self.Pair.Target = local.deviceID
	self.Target.DeviceID = local.deviceID

	apply(t, store, serviceID, local, []controlplane.PairIdentity{impostor, self})
	if computers := inspect(t, store).Record.Computers; len(computers) != 0 {
		t.Fatalf("computers = %+v, want none recorded", computers)
	}
}

// Rows of other services are not this pass's business, and a second pair with the
// same peer over another network must not create a second tab.
func TestPlanMembersKeepsOtherServicesAndOneRowPerPeer(t *testing.T) {
	store, serviceID := openCatalog(t)
	key := newKey(t)
	local := localMember{deviceID: protocol.NewID(), publicKey: key}
	// A row belonging to a service this pass is not rewriting, so the pass has
	// something of someone else's to keep.
	userID := protocol.NewID()
	otherServiceID := registerService(t, store)
	otherNetworkID := protocol.NewID()
	otherPeer := protocol.NewID()

	seeded := inspect(t, store)
	seeded.Record.Computers = []catalog.Computer{{
		ConnectionID: otherPeer, ServiceID: otherServiceID, DisplayName: "elsewhere",
		PairID: otherPeer, NetworkID: otherNetworkID,
		LocalDeviceID: local.deviceID, RemoteDeviceID: otherPeer, UserID: userID,
		LocalPublicKey: encodeKey(key), RemotePublicKey: encodeKey(newKey(t)),
		PairRevision: 1, PairState: "active",
	}}
	if _, err := store.Commit(seeded.Revision, seeded.Record); err != nil {
		t.Fatal(err)
	}

	first, remote := plantedPair(t, local.deviceID, userID, key, "studio", protocol.NewID())
	second, _ := plantedPair(t, local.deviceID, userID, key, "studio", protocol.NewID())
	second.Pair.Target = remote.DeviceID
	second.Target = first.Target
	apply(t, store, serviceID, local, []controlplane.PairIdentity{first, second})

	computers := inspect(t, store).Record.Computers
	if len(computers) != 2 {
		t.Fatalf("computers = %+v, want the other service's row and one computer for the peer", computers)
	}
	mine, foreign := 0, 0
	for _, computer := range computers {
		if computer.ServiceID == serviceID {
			mine++
			if computer.ConnectionID != remote.DeviceID {
				t.Errorf("recorded peer = %q, want %q", computer.ConnectionID, remote.DeviceID)
			}
		}
		if computer.ServiceID == otherServiceID {
			foreign++
		}
	}
	if mine != 1 || foreign != 1 {
		t.Fatalf("computers = %+v", computers)
	}
}

// The core's maintenance pass converges within its interval, but a write that can
// change the pairs is followed by a read of its own: leaving a network invalidates
// its pairs in the same transaction, and an approval or a revocation changes one
// directly, so waiting up to thirty seconds to drop the computer is a list that
// disagrees with the page the user just used.
func TestCatalogChangesOnCoversWhatCanChangeThePairs(t *testing.T) {
	for _, method := range []string{
		"network.leave", "network.join", "devices.bind", "devices.unbind",
		"networks.create", "networks.delete", "networks.deletePair",
		"pairs.adopt", "pairs.action", "pairs.invite",
	} {
		if !catalogChangesOn(method) {
			t.Errorf("%s changes the pairs but does not re-read them", method)
		}
	}
	for _, method := range []string{"user.login", "user.current", "networks.list", "pairs.list", "pairs.pin"} {
		if catalogChangesOn(method) {
			t.Errorf("%s cannot change the pairs, so it must not trigger a read", method)
		}
	}
}

// A pass that found the same pairs must not tell the shell anything: the revision
// is what makes every list re-read, and a heartbeat is not news.
func TestAnnounceCatalogSpeaksOncePerRevision(t *testing.T) {
	host := New(context.Background())
	recorder := newAnnounceRecorder()
	host.BindMain(recorder)
	account := &account{identity: controlplane.Identity{ServiceID: protocol.NewID()}, host: host}

	account.announceCatalog("revision-one")
	account.announceCatalog("revision-one")
	account.announceCatalog("revision-two")

	announcements := recorder.announcements()
	if len(announcements) != 2 {
		t.Fatalf("announcements = %+v, want one per distinct revision", announcements)
	}
	if !strings.Contains(announcements[0], "catalog.changed") ||
		!strings.Contains(announcements[0], account.identity.ServiceID) ||
		!strings.Contains(announcements[0], "revision-one") {
		t.Fatalf("announcement = %q", announcements[0])
	}
}

// The catalog lives beside the pairing half of the core, so a core composed
// without one records nothing and says so instead of behaving as if it were empty.
func TestRefreshCatalogRefusesWithoutAStore(t *testing.T) {
	account := &account{identity: controlplane.Identity{ServiceID: protocol.NewID()}, host: New(context.Background())}

	if _, err := account.refreshCatalog(context.Background()); err == nil {
		t.Fatal("a core without a catalog must refuse the refresh")
	}
}
