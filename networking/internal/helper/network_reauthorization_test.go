package helper

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/controlplane"
)

func TestNetworkReselectionReauthorizesOnlyItsExactEngineIntentAfterDurableCommit(t *testing.T) {
	f, first, second := multiNetworkFixture(t)
	before := inspectNetworkChoices(t, f)
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, first.Pair.NetworkID, before.CatalogRevision); err != nil {
		t.Fatal(err)
	}
	f.host.AutoConnectEngine().Close()
	var connected atomic.Bool
	var calls atomic.Int32
	var selectedSecond atomic.Bool
	intent := autoconnect.Intent{ServiceID: f.account.identity.ServiceID, PairID: first.Target.DeviceID}
	engine := autoconnect.New(autoconnect.Options{
		Intents: func(context.Context) ([]autoconnect.Intent, error) { return []autoconnect.Intent{intent}, nil },
		Stage: func(string, string) autoconnect.ConnectionState {
			if connected.Load() {
				return autoconnect.ConnectionState{Stage: "connected"}
			}
			return autoconnect.ConnectionState{}
		},
		Connect: func(context.Context, string, string) error {
			calls.Add(1)
			saved, err := f.host.catalog.Inspect()
			if err != nil {
				return err
			}
			for _, computer := range saved.Record.Computers {
				if computer.RemoteDeviceID == first.Target.DeviceID && computer.PairState == "active" && computer.NetworkID == second.Pair.NetworkID {
					selectedSecond.Store(true)
					connected.Store(true)
					return nil
				}
			}
			return errors.New("p2p.pair_revoked")
		},
		CodeOf: func(err error) string { return err.Error() },
	})
	f.host.mu.Lock()
	f.host.reconnect = engine
	f.host.mu.Unlock()
	engine.Reconcile(context.Background())
	if code, blocked := engine.Refusal(intent.ServiceID, intent.PairID); !blocked || code != "p2p.pair_revoked" {
		t.Fatal("old scope did not establish the terminal precondition", code)
	}
	f.mu.Lock()
	f.scopedIdentities = append([]controlplane.PairIdentity{second}, f.scopedIdentities[2:]...)
	f.mu.Unlock()
	stale := inspectNetworkChoices(t, f)
	if _, err := chooseNetwork(t, f, first.Target.DeviceID, second.Pair.NetworkID, stale.CatalogRevision); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	for !connected.Load() {
		select {
		case <-deadline:
			t.Fatal("durable new scope remained blocked by the old engine terminal")
		case <-time.After(time.Millisecond):
		}
	}
	if !selectedSecond.Load() || calls.Load() != 2 {
		t.Fatal("new engine attempt preceded the exact durable selected network", calls.Load())
	}
	connected.Store(false)
	engine.Reconcile(context.Background())
	if !connected.Load() || calls.Load() != 3 {
		t.Fatal("later disconnect could not reconnect the selected scope", calls.Load())
	}
}
