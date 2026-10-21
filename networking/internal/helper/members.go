package helper

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"log"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// encodeKey writes a device key the way the wire and the catalog both carry it:
// standard base64, which is what encoding/json does with a []byte on either side
// of this package.
func encodeKey(key []byte) string { return base64.StdEncoding.EncodeToString(key) }

// CatalogStore is the persisted catalog as this package uses it: the whole
// record, replaced under the revision it was read at.
//
// The store belongs to the core and the pairing half of it lives here, in the
// same process, so the account records its own paired computers instead of asking
// the shell to do it. That is the point of this file: the shell used to read the
// coordinator's pairs, pin them and write the catalog back, which meant a page
// had to open before a newly paired computer existed anywhere.
type CatalogStore interface {
	Inspect() (*catalog.Snapshot, error)
	Commit(expectedRevision string, next catalog.Record) (catalog.Snapshot, error)
	CommitTransitions(expectedRevision string, steps []catalog.Record) (catalog.Snapshot, error)
}

// catalogStore is the field's type: the same interface, under a name that does not
// read as a package qualifier at every use.
type catalogStore = CatalogStore

// SetCatalog names the store the account keeps its paired computers in. A core
// composed without one records nothing and refuses the refresh, rather than
// behaving as if the catalog were empty.
func (host *Host) SetCatalog(store CatalogStore) {
	host.mu.Lock()
	host.catalog = store
	host.mu.Unlock()
}

// localMember is this machine's own identity as the record needs it.
type localMember struct {
	deviceID  string
	publicKey []byte
}

// memberPlan is one rewrite of a service's computers: the rows that must be
// dropped in a commit of their own, and the list the record ends up with.
type memberPlan struct {
	retired []catalog.Computer
	final   []catalog.Computer
}

// samePublicKey compares two device keys by their bytes, because one may arrive
// base64-encoded and the other raw.
func samePublicKey(left, right []byte) bool { return bytes.Equal(left, right) }

// remoteSide answers which end of a pair is the other machine, or false when this
// device is not one of its ends.
func remoteSide(identity controlplane.PairIdentity, localDeviceID string) (remote, local controlplane.PairDeviceIdentity, ok bool) {
	switch localDeviceID {
	case identity.Pair.Initiator:
		return identity.Target, identity.Initiator, true
	case identity.Pair.Target:
		return identity.Initiator, identity.Target, true
	default:
		return controlplane.PairDeviceIdentity{}, controlplane.PairDeviceIdentity{}, false
	}
}

// planMembers rewrites the catalog's computers for one service.
//
// Only the coordinator's active pairs are admitted, and a record naming this
// machine as its own peer is dropped wherever it appears: an older build could
// write one, and it would otherwise survive every rewrite because it belongs to
// the service being rewritten.
//
// A row of this service the coordinator's list no longer carries is marked
// revoked rather than dropped. Dropping an active pair is exactly what the
// catalog's transition guard exists to refuse — a silent loss — so the drop used
// to fail the whole commit and wedge every later sync on p2p.revocation_required
// (both machines re-enrolling left each side stuck on the other's old identity).
// The coordinator's omission is itself the evidence the authorization is gone, so
// recording it as a revocation converges the catalog while keeping the loss
// visible. A revoked row is not carried into later rewrites, so it disappears on
// the next refresh instead of accumulating.
func planMembers(saved catalog.Snapshot, serviceID string, local localMember, members []controlplane.PairIdentity) memberPlan {
	kept := make([]catalog.Computer, 0, len(saved.Record.Computers))
	for _, computer := range saved.Record.Computers {
		if computer.ServiceID == serviceID || computer.RemoteDeviceID == local.deviceID {
			continue
		}
		kept = append(kept, computer)
	}
	recorded := make(map[string]bool, len(kept))
	for _, computer := range kept {
		recorded[computer.ConnectionID] = true
	}
	fresh := make([]catalog.Computer, 0, len(members))
	freshIDs := make(map[string]bool, len(members))
	for _, member := range members {
		// The catalog only admits a positive revision and an active pair.
		if member.Pair.State != "active" || member.Pair.Revision == 0 {
			continue
		}
		remote, localSide, ok := remoteSide(member, local.deviceID)
		if !ok {
			continue
		}
		if localSide.DeviceID != local.deviceID || !samePublicKey(localSide.PublicKey, local.publicKey) {
			continue
		}
		if remote.DeviceID == localSide.DeviceID {
			continue
		}
		// One fixed tab per computer: a second pair with the same peer over
		// another network must not create a duplicate connection id.
		if recorded[remote.DeviceID] || freshIDs[remote.DeviceID] {
			continue
		}
		freshIDs[remote.DeviceID] = true
		name := remote.Name
		if name == "" {
			name = remote.DeviceID
		}
		fresh = append(fresh, catalog.Computer{
			ConnectionID: remote.DeviceID,
			ServiceID:    serviceID,
			DisplayName:  name,
			// The coordinator keys a connection attempt by the target device id and
			// the lease reports it back the same way, so the id every consumer uses
			// is the device id, not the pairs-table row id.
			PairID:          remote.DeviceID,
			NetworkID:       member.Pair.NetworkID,
			LocalDeviceID:   localSide.DeviceID,
			RemoteDeviceID:  remote.DeviceID,
			UserID:          localSide.UserID,
			LocalPublicKey:  encodeKey(localSide.PublicKey),
			RemotePublicKey: encodeKey(remote.PublicKey),
			PairRevision:    int64(member.Pair.Revision),
			PairState:       "active",
		})
	}
	carried := make([]catalog.Computer, 0, len(saved.Record.Computers))
	retired := make([]catalog.Computer, 0, len(saved.Record.Computers))
	for _, computer := range saved.Record.Computers {
		if computer.ServiceID != serviceID || computer.RemoteDeviceID == local.deviceID {
			continue
		}
		if computer.PairState == "revoked" {
			// A connection the coordinator has authorized again — the same two
			// devices re-paired, or a network rejoined — cannot be revived in the
			// same commit that replaces its revoked row: the catalog refuses to
			// take a revoked computer back to active at all. Retiring the row is
			// its own legal step, so it is committed first and the new
			// authorization is recorded against the revision that commit produced.
			if freshIDs[computer.ConnectionID] {
				retired = append(retired, computer)
			}
			continue
		}
		if freshIDs[computer.ConnectionID] {
			continue
		}
		revoked := computer
		revoked.PairState = "revoked"
		carried = append(carried, revoked)
	}
	final := make([]catalog.Computer, 0, len(kept)+len(fresh)+len(carried))
	final = append(final, kept...)
	final = append(final, fresh...)
	final = append(final, carried...)
	return memberPlan{retired: retired, final: final}
}

// refreshCatalog re-reads the account's pairs, pins them and records them.
//
// The returned revision is the catalog's after the write. Any active scoped read
// failure is typed and prevents partial bootstrap from granting live admission.
func (account *account) refreshCatalog(ctx context.Context) (string, error) {
	account.mu.Lock()
	defer account.mu.Unlock()
	return account.refreshCatalogLocked(ctx)
}

// refreshCatalogLocked is the same pass for a caller that already holds the account
// lock. `device.restore` is one: it is answered while holding that lock, and it must
// leave the pins in place before it answers, because the shell treats the answer as
// "this machine is online" and starts connecting.
func (account *account) refreshCatalogLocked(ctx context.Context) (string, error) {
	if err := checkBootstrapContext(ctx); err != nil {
		return "", err
	}
	if account.closed {
		return "", errors.New("p2p.service_unconfigured")
	}
	fresh, err := account.readNetworkSelection(ctx)
	if err != nil {
		return "", err
	}
	return account.commitNetworkSelection(ctx, fresh, "")
}

func (account *account) selectedNetworkNames(ctx context.Context, userID string) (map[string]string, error) {
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("p2p.user_login_required")
	}
	client, err := account.bearerClientLocked()
	if err != nil {
		return nil, err
	}
	user, err := client.CurrentUser(ctx, session.Token)
	if fence := checkBootstrapContext(ctx); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	if user.UserID != userID || session.ExpiresAt <= time.Now().Unix() {
		return nil, errors.New("p2p.user_scope_mismatch")
	}
	networks, err := client.Networks(ctx, session.Token)
	if fence := checkBootstrapContext(ctx); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]string, len(networks))
	for _, network := range networks {
		if !protocol.ValidID(network.NetworkID) || network.UserID != userID {
			return nil, errors.New("p2p.network_unauthorized")
		}
		allowed[network.NetworkID] = network.Name
	}
	return allowed, nil
}

// recordPlan writes a plan: the retirement step first when it is needed, then the
// record the service ends up with. Split from the read above so the two commits and
// the revision they carry — the part the catalog's guard makes delicate — are one
// function with one job.
func recordPlan(store CatalogStore, saved catalog.Snapshot, plan memberPlan) (string, error) {
	revision := saved.Revision
	if len(plan.retired) > 0 {
		committed, err := store.Commit(revision, withoutComputers(saved.Record, plan.retired))
		if err != nil {
			return "", err
		}
		revision = committed.Revision
	}
	next := saved.Record
	next.Computers = plan.final
	committed, err := store.Commit(revision, next)
	if err != nil {
		return "", err
	}
	return committed.Revision, nil
}

// catalogInputs reads the pieces one refresh needs under the account lock, so a
// concurrent logout cannot swap the client mid-pass.
func (account *account) catalogInputs() (CatalogStore, *controlplane.Client, localMember, string) {
	account.mu.Lock()
	defer account.mu.Unlock()
	return account.catalogInputsLocked()
}

// catalogInputsLocked is that read for a caller that already holds the lock. It
// still takes the host lock for the store, which no caller of this holds.
func (account *account) catalogInputsLocked() (CatalogStore, *controlplane.Client, localMember, string) {
	var store CatalogStore
	if account.host != nil {
		account.host.mu.Lock()
		store = account.host.catalog
		account.host.mu.Unlock()
	}
	return store, account.client, localMember{
		deviceID:  account.device.DeviceID,
		publicKey: account.device.PublicKey,
	}, account.identity.ServiceID
}

// withoutComputers is the record with the named rows dropped, by connection id
// and service: the intermediate step a re-authorized connection needs.
func withoutComputers(record catalog.Record, drop []catalog.Computer) catalog.Record {
	next := record
	next.Computers = make([]catalog.Computer, 0, len(record.Computers))
	for _, computer := range record.Computers {
		discard := false
		for _, candidate := range drop {
			if computer.ConnectionID == candidate.ConnectionID && computer.ServiceID == candidate.ServiceID {
				discard = true
				break
			}
		}
		if !discard {
			next.Computers = append(next.Computers, computer)
		}
	}
	return next
}

// maintainCatalog re-reads the pairs on the interval and tells the shell when the
// catalog moved.
func (account *account) maintainCatalog(ctx context.Context) {
	ticker := time.NewTicker(DirectoryMaintenanceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			store, client, _, _ := account.catalogInputs()
			if store == nil || client == nil {
				continue
			}
			readCtx, cancel := context.WithTimeout(ctx, directoryRefreshTimeout)
			account.mu.Lock()
			scope, scopeErr := account.selectedSessionScopeLocked(readCtx)
			account.mu.Unlock()
			if scopeErr != nil {
				cancel()
				log.Printf("[p2p] catalog refresh refused: %s", scopeErr.Error())
				continue
			}
			readCtx = scope.Context(readCtx)
			revision, err := account.refreshCatalog(readCtx)
			// A failed pass keeps whatever the catalog already holds: the
			// coordinator being briefly unreachable is not evidence that the pairs
			// went away, and rewriting the record from a failed read is what would
			// revoke every computer at once. It is logged rather than dropped,
			// because the failure it hides is "this machine cannot accept a
			// connection", which no user surface would otherwise explain.
			if err != nil {
				cancel()
				log.Printf("[p2p] catalog refresh failed: %v", err)
				continue
			}
			err = account.announceScopedCatalog(readCtx, scope, revision)
			cancel()
			if err != nil {
				log.Printf("[p2p] catalog publication refused: %s", err.Error())
			}
		}
	}
}

// refreshCatalogAfterWrite re-reads the pairs once a successful operation may
// have changed them. Failures remain explicit in this background maintenance log.
func (account *account) refreshCatalogAfterWrite(ctx context.Context) error {
	scope, err := account.selectedSessionScopeLocked(ctx)
	if err != nil {
		return err
	}
	background, err := scope.Background(scope.Context(ctx))
	if err != nil {
		return err
	}
	go func() {
		ctx, cancel := context.WithTimeout(background.Context(account.maintenanceLifetime()), directoryRefreshTimeout)
		defer cancel()
		revision, err := account.refreshCatalog(ctx)
		if err != nil {
			// The write already completed; this is
			// the bookkeeping behind it, and a failure here means the pins and the
			// recorded computers are stale rather than wrong.
			log.Printf("[p2p] catalog refresh after a write failed: %v", err)
			return
		}
		if err := account.announceScopedCatalog(ctx, background, revision); err != nil {
			log.Printf("[p2p] catalog after-write publication refused: %s", err.Error())
		}
	}()
	return nil
}

func (account *account) announceScopedCatalog(ctx context.Context, scope *selectedSessionScope, revision string) error {
	var changed bool
	account.mu.Lock()
	err := scope.Publish(ctx, func() error {
		changed = account.catalogRevision != revision
		account.catalogRevision = revision
		return nil
	})
	account.mu.Unlock()
	if err != nil || !changed {
		return err
	}
	if err := checkBootstrapContext(ctx); err != nil {
		return err
	}
	account.host.announceCatalog(scope.serviceID, revision)
	return checkBootstrapContext(ctx)
}

// announceCatalog tells the shell that the computers it renders have moved. A
// revision that has already been announced is not repeated, so a pass that found
// the same pairs does not make every list re-read.
func (account *account) announceCatalog(revision string) {
	account.mu.Lock()
	previous := account.catalogRevision
	account.catalogRevision = revision
	account.mu.Unlock()
	if previous == revision || account.host == nil {
		return
	}
	account.host.announceCatalog(account.identity.ServiceID, revision)
}

// peerRegistrationChanged converges the saved peer catalog and visible device
// directory when another computer signs in, adopts a network or goes offline.
// The signaling receive loop only schedules this bounded read; it never waits on
// account HTTP, catalog I/O or renderer IPC.
func (account *account) peerRegistrationChanged(event protocol.PeerRegistration) {
	if !protocol.ValidID(event.DeviceID) || !protocol.ValidID(event.UserID) || account.host == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(account.maintenanceLifetime(), directoryRefreshTimeout)
		defer cancel()
		account.mu.Lock()
		if account.closed || account.client == nil || account.client.Account() != event.UserID || event.DeviceID == account.device.DeviceID {
			account.mu.Unlock()
			return
		}
		scope, err := account.selectedSessionScopeLocked(ctx)
		account.mu.Unlock()
		if err != nil {
			log.Printf("[p2p] peer registration refresh refused: %s", err.Error())
			return
		}
		ctx = scope.Context(ctx)
		if event.Online {
			revision, err := account.refreshCatalog(ctx)
			if err != nil {
				log.Printf("[p2p] peer registration catalog refresh failed: %v", err)
			} else {
				// Revalidate this exact session after the network read without writing
				// account state from the background callback. The catalog revision is
				// owned by account.mu; mutating it here would race maintenance and could
				// invert the account/bootstrap lock order.
				if err = scope.Publish(ctx, func() error { return nil }); err != nil {
					log.Printf("[p2p] peer registration catalog publication refused: %s", err.Error())
					return
				}
				// A registration is also an invalidation of network choices, even
				// when the persisted computer rows already had this revision.
				account.host.announceCatalog(account.identity.ServiceID, revision)
			}
		}
		if _, err = account.refreshDirectory(ctx); err != nil {
			log.Printf("[p2p] peer registration directory refresh failed: %v", err)
		}
	}()
}

// announceCatalog is the host half: the parent channel, when there is one.
func (host *Host) announceCatalog(serviceID string, revision string) {
	host.mu.Lock()
	main := host.main
	host.mu.Unlock()
	if main == nil {
		return
	}
	ctx, cancel := context.WithTimeout(host.ctx, 5*time.Second)
	defer cancel()
	_, _ = main.Call(ctx, "catalog.changed", struct {
		ServiceID string `json:"serviceId"`
		Revision  string `json:"revision"`
	}{serviceID, revision})
}
