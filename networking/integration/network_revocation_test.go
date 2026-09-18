package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestManagerNetworkRevocationRealDSH(t *testing.T) {
	runtimeURL, _ := startRealDSH(t)
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 40*time.Second)
	defer cancel()
	var managers [2]*peersession.Manager
	for _, i := range []int{1, 0} {
		config := f.config[i]
		// Presence belongs to the signed-in account; the manager cannot make an
		// account-less fixture online by inference.
		f.devices[i].SetAccount(config.Device.UserID)
		owner := func(context.Context, string) (runtimebridge.Binding, error) {
			if i != 1 {
				return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_owner")
			}
			return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
		}
		manager, err := peersession.New(ctx, f.devices[i], peersession.Config{Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device, PrivateKey: config.Private}, []controlplane.PairIdentity{config.Pin}, owner, func(peersession.State) {})
		must(t, err)
		managers[i] = manager
		defer manager.Close()
	}
	time.Sleep(time.Second)
	pin := f.config[0].Pin
	connected, err := managers[0].Connect(ctx, pin.Pair.PairID, 1)
	must(t, err)
	must(t, runtimebridge.Probe(ctx, connected.URL))
	must(t, f.client.DeleteNetwork(ctx, f.userSession.Token, pin.Pair.NetworkID))
	must(t, managers[0].RevokeNetwork(pin.Pair.NetworkID))
	assertGatewayClosed(t, ctx, connected.URL)
	waitManagerNotConnected(t, ctx, managers[1], pin.Pair.PairID)
	if err := managers[0].Pin(pin); err == nil || err.Error() != "p2p.network_revoked" {
		t.Fatalf("deleted network repinned: %v", err)
	}
	_, err = managers[0].Connect(ctx, pin.Pair.PairID, 2)
	if err == nil || err.Error() != "p2p.pair_unauthorized" {
		t.Fatalf("revoked network reconnected: %v", err)
	}
	must(t, managers[0].RevokeNetwork(pin.Pair.NetworkID))
	must(t, runtimebridge.Probe(ctx, runtimeURL))
}
