package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// The production coordinator, TLS/WSS registrations and both production peer
// managers participate. The adopted membership invalidation must reach the
// other signed-in computer without a directory refresh request from that peer.
func TestNetworkAdoptionNotifiesOnlinePeerManager(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
	defer cancel()
	registrations := make(chan protocol.PeerRegistration, 16)
	var managers [2]*peersession.Manager
	for index := range managers {
		config := f.config[index]
		f.devices[index].SetAccount(f.userSession.User.UserID)
		manager, err := peersession.New(ctx, f.devices[index], peersession.Config{
			Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device,
			PrivateKey: config.Private, CoreInstanceID: integrationCoreInstanceID(t),
			PeerRegistration: func(event protocol.PeerRegistration) {
				if index == 1 {
					registrations <- event
				}
			},
		}, []controlplane.PairIdentity{}, func(context.Context, string) (runtimebridge.Binding, error) {
			return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_request")
		}, func(peersession.State) {})
		must(t, err)
		identity := config.Pin
		_, err = manager.PinScopedIdentity(ctx, f.userSession.User.UserID, identity.Pair.NetworkID, identity.Pair.PairID)
		must(t, err)
		must(t, manager.ActivateCandidates(ctx))
		managers[index] = manager
		t.Cleanup(manager.Close)
	}
	// Discard initial WSS registration snapshots so only the adoption push can
	// satisfy the assertion below.
	for {
		select {
		case <-registrations:
		default:
			goto initialRegistrationsDrained
		}
	}

initialRegistrationsDrained:
	if _, err := f.devices[0].AdoptNetwork(ctx); err != nil {
		t.Fatal("confirmed network adoption failed", err)
	}
	for {
		select {
		case event := <-registrations:
			if event.DeviceID != f.config[0].Device.DeviceID || event.UserID != f.userSession.User.UserID || !event.Online {
				t.Fatalf("network adoption notified a different account/device state: %+v", event)
			}
			return
		case <-ctx.Done():
			t.Fatal("online peer did not receive the automatic network membership invalidation", ctx.Err())
		}
	}
}
