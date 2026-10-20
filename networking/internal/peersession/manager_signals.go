package peersession

import (
	"context"
	"errors"
	"log"
	"sync"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// ReconnectSignals repairs the coordinator subscription when its socket was
// displaced by a newer process or became unusable while the daemon itself stayed
// alive. A manager used to stand down permanently in that state: every later
// peer.connect returned p2p.server_unavailable until the whole launcher restarted.
// The caller invokes this before an explicit connect and from each reconciliation
// pass, so a healthy socket is never replaced and two healthy processes do not
// continuously kick each other off.
func (manager *Manager) ReconnectSignals(ctx context.Context) error {
	return manager.reconnectSignals(ctx, false)
}

// SetAccount replaces the authenticated registration when the selected account
// changes. Static membership is not current signed-in presence.
func (manager *Manager) SetAccount(ctx context.Context, userID string) error {
	if userID != "" && !protocol.ValidID(userID) {
		return errors.New("p2p.invalid_request")
	}
	manager.mu.Lock()
	changed, retired := manager.replaceAccountScopeLocked(userID)
	manager.mu.Unlock()
	if !changed {
		return nil
	}
	retired.finish()
	return manager.reconnectSignals(ctx, true)
}

type accountScopeRetirement struct {
	ending     []*endCleanup
	previous   []*session
	endpoints  []*runtimebridge.Endpoint
	admissions []*inboundAdmission
}

// A completion is owned by the Host operation that requested the local fence.
// Wait must run after releasing account.mu: an old receive/emit can need it.
type AccountRecoveryCompletion struct {
	previous *signaling
	retired  accountScopeRetirement
	once     sync.Once
}

func (completion *AccountRecoveryCompletion) Wait() {
	completion.once.Do(func() {
		completion.retired.finish()
		if completion.previous != nil {
			completion.previous.closeAndWait()
		}
	})
}

// FenceAccountForCertificateRecovery performs no dial and claims no remote End
// receipt. Only the helper's fully validated expired-device auth owner calls it.
// A same-account recovery retains its workbench intent, stable gateways, pins,
// sessions and owned cleanup. They cannot admit candidates without registration.
func (manager *Manager) FenceAccountForCertificateRecovery(userID string) (*AccountRecoveryCompletion, error) {
	if userID != "" && !protocol.ValidID(userID) {
		return nil, errors.New("p2p.invalid_request")
	}
	manager.reconnectMu.Lock()
	defer manager.reconnectMu.Unlock()
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return nil, errors.New("p2p.helper_unavailable")
	}
	_, retired := manager.replaceAccountScopeLocked(userID)
	manager.candidatesActive = false
	previous := manager.signals
	retired.admissions = append(retired.admissions, manager.cancelInboundAdmissionsLocked(previous)...)
	manager.signals = nil
	manager.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	return &AccountRecoveryCompletion{previous: previous, retired: retired}, nil
}

// FenceAccountForLogout revokes only this Manager's local account authority.
// It has no caller context, nonempty target, dial, certificate requirement or
// claim about remote revocation/End. Even a closed Manager retains the returned
// completion for its old signaling workers; closed is still a typed failure.
func (manager *Manager) FenceAccountForLogout() (*AccountRecoveryCompletion, error) {
	manager.reconnectMu.Lock()
	defer manager.reconnectMu.Unlock()
	manager.mu.Lock()
	closed := manager.closed
	manager.client.SetAccount("")
	retired := manager.retireAccountScopeLocked("")
	manager.candidatesActive = false
	previous := manager.signals
	retired.admissions = append(retired.admissions, manager.cancelInboundAdmissionsLocked(previous)...)
	manager.signals = nil
	manager.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	completion := &AccountRecoveryCompletion{previous: previous, retired: retired}
	if closed {
		return completion, errors.New("p2p.helper_unavailable")
	}
	return completion, nil
}

// Caller holds manager.mu. Preserve the normal SetAccount same-user contract.
func (manager *Manager) replaceAccountScopeLocked(userID string) (bool, accountScopeRetirement) {
	retired := accountScopeRetirement{}
	if !manager.client.SetAccount(userID) {
		return false, retired
	}
	return true, manager.retireAccountScopeLocked(userID)
}

// Caller holds manager.mu. Logout retires even an already empty account, so an
// idempotent local fence cannot retain stale pins, gateways or workbench intent.
func (manager *Manager) retireAccountScopeLocked(userID string) accountScopeRetirement {
	retired := accountScopeRetirement{}
	manager.accountUserID = userID
	manager.candidatesActive = false
	for _, job := range manager.endJobs {
		if job.ticket.Lease.UserID != userID {
			job.cancel()
			retired.ending = append(retired.ending, job)
		}
	}
	for _, connection := range manager.allSessionsLocked() {
		if (connection.ticket != nil && connection.ticket.Lease.UserID != userID) || (connection.prepare != nil && connection.prepare.UserID != userID) {
			retired.previous = append(retired.previous, connection)
			delete(manager.workbenches, connection.PairID)
		}
	}
	for _, admission := range manager.inboundAdmissions {
		if admission.connection.lease.UserID != userID {
			admission.connection.stop("account_changed", errors.New("p2p.user_unauthorized"))
			retired.admissions = append(retired.admissions, admission)
		}
	}
	clear(manager.workbenches)
	clear(manager.pins)
	clear(manager.revokedPairs)
	clear(manager.revokedNetworks)
	for _, slots := range []map[string]*runtimebridge.Endpoint{manager.endpoints, manager.inboundEndpoints} {
		for _, endpoint := range slots {
			retired.endpoints = append(retired.endpoints, endpoint)
		}
	}
	manager.endpoints = make(map[string]*runtimebridge.Endpoint)
	manager.inboundEndpoints = make(map[string]*runtimebridge.Endpoint)
	return retired
}

func (retired accountScopeRetirement) finish() {
	for _, job := range retired.ending {
		<-job.done
	}
	for _, connection := range retired.previous {
		connection.stop("account_changed", errors.New("p2p.user_unauthorized"))
	}
	for _, admission := range retired.admissions {
		<-admission.done
	}
	for _, endpoint := range retired.endpoints {
		endpoint.Close()
	}
}

// Cancellation is local and nonjoining under manager.mu. The returned owner is
// joined by the explicit account completion after the helper lock is released.
func (manager *Manager) cancelInboundAdmissionsLocked(owner *signaling) []*inboundAdmission {
	var admissions []*inboundAdmission
	for _, admission := range manager.inboundAdmissions {
		if owner == nil || admission.owner == owner {
			admission.connection.stop("registration_ended", errors.New("p2p.registration_stale"))
			admissions = append(admissions, admission)
		}
	}
	return admissions
}

func (manager *Manager) reconnectSignals(ctx context.Context, force bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Only one caller may replace a displaced subscription. Reconciliation and
	// an explicit retry can arrive together; without this lock they both dial,
	// and the later socket displaces the one already installed by the first.
	manager.reconnectMu.Lock()
	defer manager.reconnectMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return errors.New("p2p.helper_unavailable")
	}
	current := manager.signals
	manager.mu.Unlock()
	// An absent subscription is repairable, not a healthy state. The manager holds
	// none when the very first dial failed while it was being created, and the
	// supervisor that would have retried is only started by a successful dial — so
	// treating nil as "nothing to do" left the account permanently unable to
	// signal, which is the same dead end a displaced socket used to cause.
	if current != nil && !current.isDown() && !force {
		return nil
	}
	if current == nil {
		log.Printf("[p2p] signalling absent for device %s; subscribing", manager.config.Device.DeviceID)
	} else {
		log.Printf("[p2p] signalling down for device %s; resubscribing", manager.config.Device.DeviceID)
		// Stop the old supervisor before opening its replacement. Otherwise a retry
		// already in progress could open a second socket after this method returns
		// and displace the subscription we just installed.
		current.close()
	}
	// Subscribe owns its socket, read loop and heartbeats through the context it
	// receives. The RPC context dies as soon as this call replies, so attaching
	// the replacement to it makes a successful reconnect immediately disconnect.
	next, err := newSignalingInstalled(manager.ctx, manager.subscribe, manager.config.Device.DeviceID, manager.receive, func(next *signaling) error {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		if manager.closed {
			return errors.New("p2p.helper_unavailable")
		}
		manager.signals = next
		return nil
	})
	if err != nil {
		log.Printf("[p2p] signalling repair failed for device %s: %v", manager.config.Device.DeviceID, err)
		return err
	}
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		next.close()
		return errors.New("p2p.helper_unavailable")
	}
	manager.signals = next
	manager.mu.Unlock()
	log.Printf("[p2p] signalling repaired for device %s", manager.config.Device.DeviceID)
	return nil
}
