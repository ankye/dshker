package helper

import (
	"context"
	"encoding/json"
	"errors"
	"log"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/secret"
)

// RestoreOwnCredentials brings every service this machine is enrolled with back
// online from the core's own records, with no desktop and no client involved.
//
// A headless core used to come up unable to act as the device it already held the
// key for. Enrollment produced the whole credential inside the core, but the core
// returned it and kept only the private key, so the record naming what that key was
// enrolled as — the coordinator-issued device id, the signed certificate, the
// account it belongs to — existed only in the desktop's encrypted store. `dshkerd
// serve` therefore published its endpoint, answered every method, and never reached
// the coordinator: nothing could tell it who it was, so it held no subscription,
// reported no presence, and every attempt toward it saw an offline peer while the
// machine looked installed and running.
//
// It is safe on a machine with nothing stored: a core that was never enrolled, or
// one whose desktop still owns the only copy, has no record to restore and reports
// zero.
func (host *Host) RestoreOwnCredentials(ctx context.Context) (restored int) {
	host.mu.Lock()
	store := host.deviceKeys
	host.mu.Unlock()
	if store == nil {
		// Without a provider the core cannot have recorded anything, so there is
		// nothing to restore and nothing is wrong: a desktop-driven machine keeps
		// working exactly as before.
		return 0
	}
	for _, serviceID := range credentialIndex(store) {
		if ctx.Err() != nil {
			return restored
		}
		credential, err := host.LoadCredential(serviceID)
		if err != nil {
			// The index names it but the record is gone or unreadable. That is worth
			// naming: it is the difference between "nothing to restore" and "the
			// identity this machine should have is unusable".
			if !errors.Is(err, secret.ErrMissing) {
				log.Printf("[p2p] credential unreadable for service %s: %v", serviceID, err)
			} else {
				log.Printf("[p2p] credential listed but missing for service %s", serviceID)
			}
			continue
		}
		if err := host.restoreStoredCredential(ctx, credential); err != nil {
			// One unreachable coordinator must not stop the next service from coming
			// back, and the reconnection pass retries on its own schedule.
			log.Printf("[p2p] stored credential could not be restored for service %s: %v", serviceID, err)
			continue
		}
		restored++
		log.Printf("[p2p] restored device %s for service %s from the core's own credential",
			credential.DeviceID, serviceID)
	}
	return restored
}

// restoreStoredCredential activates one service and restores its device through the
// same internal operations the desktop drives, so a headless restore and a desktop
// restore produce the same account rather than two similar ones.
func (host *Host) restoreStoredCredential(ctx context.Context, credential storedCredential) error {
	configuration, err := json.Marshal(struct {
		Endpoints controlplane.Endpoints `json:"endpoints"`
		PinnedKey []byte                 `json:"pinnedKey"`
		Telemetry controlplane.Telemetry `json:"telemetry"`
	}{
		Endpoints: credential.Endpoints,
		// The service key recorded with the credential is pinned exactly as the shell
		// pins it, so a coordinator answering with another identity is refused here
		// too rather than trusted because no desktop was watching.
		PinnedKey: credential.ServiceKey,
	})
	if err != nil {
		return errors.New("p2p.invalid_service_identity")
	}
	if _, err := host.configure(ctx, configuration); err != nil {
		return err
	}
	host.mu.Lock()
	account := host.accounts[credential.ServiceID]
	host.mu.Unlock()
	if account == nil {
		return errors.New("p2p.service_unconfigured")
	}
	payload, err := json.Marshal(struct {
		Device     controlplane.Device         `json:"device"`
		PrivateKey []byte                      `json:"privateKey"`
		Pins       []controlplane.PairIdentity `json:"pins"`
	}{
		Device:     credential.device(),
		PrivateKey: credential.PrivateKey,
		// Pins are the core's own: the catalog pass inside restore re-pins every
		// active pair, so a restore hands over none.
		Pins: nil,
	})
	if err != nil {
		return errors.New("p2p.invalid_device_state")
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	// An account a desktop already restored is left exactly as it is: the shell's
	// session owns it, and replacing it would drop a working subscription.
	if account.manager != nil {
		return nil
	}
	if _, err := host.restore(ctx, account, payload); err != nil {
		return err
	}
	return nil
}
