package helper

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

// DirectoryMaintenanceInterval is how often a signed-in account's directory is
// re-read while nothing else asks for it.
//
// The coordinator persists a device's last-seen at most once a minute and answers
// presence from its live session table, so a faster cadence would only ask the
// same question more often. This is the floor, not the only trigger: a session
// that is newly learned, a write that changes who belongs to a network, and an
// explicit refresh all read immediately.
const DirectoryMaintenanceInterval = 30 * time.Second

// directoryRefreshTimeout bounds one background read of the whole directory, so a
// coordinator that stops answering cannot pin the account's lock forever.
const directoryRefreshTimeout = 20 * time.Second

// DirectoryNetwork is one owned network with its members, as the core holds them.
type DirectoryNetwork struct {
	NetworkID  string                     `json:"networkId"`
	UserID     string                     `json:"userId"`
	Name       string                     `json:"name"`
	MaxDevices int                        `json:"maxDevices"`
	Devices    []controlplane.DeviceEntry `json:"devices"`
}

// DirectoryView is the whole snapshot the shell renders.
//
// It is deliberately one value per service: the account's bound devices and every
// owned network's members come from one read by one owner. Known is false when
// nothing has been read yet, which is a state and not an empty directory — a
// shell must be able to say "not read" rather than show an account as having no
// devices.
type DirectoryView struct {
	ServiceID string                     `json:"serviceId"`
	Known     bool                       `json:"known"`
	Revision  uint64                     `json:"revision"`
	FetchedAt int64                      `json:"fetchedAt"`
	Networks  []DirectoryNetwork         `json:"networks"`
	Devices   []controlplane.DeviceEntry `json:"devices"`
}

// directory is the per-account snapshot and the session it belongs to.
//
// The token is not this store's property: the shell owns signing in and hands the
// token to whichever call needs it. Keeping the last one seen is what lets the
// core maintain the directory on its own — at startup the first token-bearing
// read is already enough to bring the list up to date and announce it.
type directory struct {
	mu    sync.Mutex
	token string
	view  DirectoryView
	// reading marks an in-flight refresh, so an interval tick and an explicit
	// refresh that arrive together perform one read rather than two.
	reading bool
}

// rememberToken records the user session this account is currently used with.
//
// It reports whether the session is new, which is the moment a refresh is worth
// starting: a repeated call with the same token is the ordinary case and must not
// turn every read into a coordinator round trip.
func (account *account) rememberToken(token string) bool {
	account.directory.mu.Lock()
	defer account.directory.mu.Unlock()
	if token == "" || token == account.directory.token {
		return false
	}
	account.directory.token = token
	return true
}

// forgetToken drops the session, so a signed-out account stops being maintained.
func (account *account) forgetToken() {
	account.directory.mu.Lock()
	account.directory.token = ""
	// A signed-out account has no directory: leaving the previous account's rows
	// in place would show one account's devices under another's session.
	account.directory.view = DirectoryView{}
	account.directory.mu.Unlock()
}

// snapshot copies the current view for the caller.
func (account *account) snapshot(serviceID string) DirectoryView {
	account.directory.mu.Lock()
	defer account.directory.mu.Unlock()
	return copyDirectoryView(account.directory.view, serviceID)
}

func copyDirectoryView(view DirectoryView, serviceID string) DirectoryView {
	copied := DirectoryView{
		ServiceID: serviceID,
		Known:     view.Known,
		Revision:  view.Revision,
		FetchedAt: view.FetchedAt,
		Networks:  make([]DirectoryNetwork, 0, len(view.Networks)),
		// An empty list is encoded as an empty array, never as null: the shell
		// validates these fields as arrays, and null is not one.
		Devices: entriesOrEmpty(view.Devices),
	}
	for _, network := range view.Networks {
		copied.Networks = append(copied.Networks, DirectoryNetwork{
			NetworkID:  network.NetworkID,
			UserID:     network.UserID,
			Name:       network.Name,
			MaxDevices: network.MaxDevices,
			Devices:    entriesOrEmpty(network.Devices),
		})
	}
	return copied
}

// entriesOrEmpty returns a slice that encodes as an array even when it is empty.
func entriesOrEmpty(entries []controlplane.DeviceEntry) []controlplane.DeviceEntry {
	if entries == nil {
		return []controlplane.DeviceEntry{}
	}
	return append([]controlplane.DeviceEntry(nil), entries...)
}

// readDirectory reads the whole directory with the session this account holds.
//
// The account lock is taken for the duration: the coordinator client is the same
// one the shell's calls use, and serialising them keeps one account's requests in
// a single order instead of interleaving a background read with a user action.
func (account *account) readDirectory(ctx context.Context) (DirectoryView, error) {
	account.mu.Lock()
	defer account.mu.Unlock()
	account.directory.mu.Lock()
	token := account.directory.token
	account.directory.mu.Unlock()
	if token == "" {
		return DirectoryView{}, errors.New("p2p.user_login_required")
	}
	networks, err := account.base.Networks(ctx, token)
	if err != nil {
		return DirectoryView{}, err
	}
	view := DirectoryView{
		Known:     true,
		FetchedAt: time.Now().Unix(),
		Networks:  make([]DirectoryNetwork, 0, len(networks)),
		Devices:   []controlplane.DeviceEntry{},
	}
	for _, network := range networks {
		devices, err := account.base.NetworkDevices(ctx, token, network.NetworkID)
		if err != nil {
			return DirectoryView{}, err
		}
		view.Networks = append(view.Networks, DirectoryNetwork{
			NetworkID:  network.NetworkID,
			UserID:     network.UserID,
			Name:       network.Name,
			MaxDevices: network.MaxDevices,
			Devices:    entriesOrEmpty(devices),
		})
	}
	devices, err := account.base.UserDevices(ctx, token)
	if err != nil {
		return DirectoryView{}, err
	}
	view.Devices = entriesOrEmpty(devices)
	return view, nil
}

// refreshDirectory reads the directory and publishes the result.
//
// The revision only moves when the content does, because it is what tells the
// shell that the list it mirrors is now wrong; a heartbeat that says "still the
// same devices" must not make the renderer re-render every list it has.
func (account *account) refreshDirectory(ctx context.Context) (DirectoryView, error) {
	view, err := account.readDirectory(ctx)
	if err != nil {
		return account.snapshot(""), err
	}
	account.directory.mu.Lock()
	changed := !sameDirectoryContent(account.directory.view, view)
	// The revision is the stored one either way: a read that found the same
	// devices must answer with the revision the shell already mirrors, not with
	// the zero value of a freshly decoded reply.
	view.Revision = account.directory.view.Revision
	if changed {
		view.Revision++
	}
	account.directory.view = view
	account.directory.mu.Unlock()
	if changed {
		account.announce(view.Revision)
	}
	return copyDirectoryView(view, account.identity.ServiceID), nil
}

// announce tells the shell about a new revision. An account composed without a
// host — the unit tests build one — simply has no shell to tell.
func (account *account) announce(revision uint64) {
	if account.host == nil {
		return
	}
	account.host.announceDirectory(account.identity.ServiceID, revision)
}

// maintenanceLifetime is the context background work follows: the host's own, or
// a detached one for an account that has no host to outlive.
func (account *account) maintenanceLifetime() context.Context {
	if account.host != nil {
		return account.host.ctx
	}
	return context.Background()
}

// sameDirectoryContent compares the parts of a snapshot a reader can see.
func sameDirectoryContent(left, right DirectoryView) bool {
	if !left.Known {
		return false
	}
	leftBytes, err := json.Marshal(struct {
		Networks []DirectoryNetwork
		Devices  []controlplane.DeviceEntry
	}{copyDirectoryView(left, "").Networks, entriesOrEmpty(left.Devices)})
	if err != nil {
		return false
	}
	rightBytes, err := json.Marshal(struct {
		Networks []DirectoryNetwork
		Devices  []controlplane.DeviceEntry
	}{copyDirectoryView(right, "").Networks, entriesOrEmpty(right.Devices)})
	if err != nil {
		return false
	}
	return string(leftBytes) == string(rightBytes)
}

// maintainDirectory re-reads a signed-in account's directory on the interval.
func (account *account) maintainDirectory(ctx context.Context) {
	ticker := time.NewTicker(DirectoryMaintenanceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			account.directory.mu.Lock()
			signedIn := account.directory.token != ""
			account.directory.mu.Unlock()
			if !signedIn {
				continue
			}
			readCtx, cancel := context.WithTimeout(ctx, directoryRefreshTimeout)
			// A failed refresh keeps the last good snapshot: the coordinator being
			// briefly unreachable is not evidence that the devices went away.
			_, _ = account.refreshDirectory(readCtx)
			cancel()
		}
	}
}

// announceDirectory tells the shell that the snapshot it mirrors has moved.
func (host *Host) announceDirectory(serviceID string, revision uint64) {
	host.mu.Lock()
	main := host.main
	host.mu.Unlock()
	if main == nil {
		return
	}
	ctx, cancel := context.WithTimeout(host.ctx, 5*time.Second)
	defer cancel()
	_, _ = main.Call(ctx, "directory.changed", struct {
		ServiceID string `json:"serviceId"`
		Revision  uint64 `json:"revision"`
	}{serviceID, revision})
}

// refreshAfterWrite re-reads the directory once an operation that changes who
// belongs to a network has succeeded.
//
// It runs on its own goroutine because the caller still holds the account lock;
// the read waits for that lock, so the response the user is waiting for is not
// delayed by a bookkeeping read.
func (account *account) refreshAfterWrite() {
	go func() {
		ctx, cancel := context.WithTimeout(account.maintenanceLifetime(), directoryRefreshTimeout)
		defer cancel()
		_, _ = account.refreshDirectory(ctx)
	}()
}
