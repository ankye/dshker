package helper

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestHostMaintenanceRetainsTerminalServicesAndRejectsGlobalReset(t *testing.T) {
	host := New(context.Background())
	defer host.Close()
	host.SetDeviceKeys(newMemoryStore())
	serviceA, serviceB, pair := protocol.NewID(), protocol.NewID(), protocol.NewID()
	intents := []autoconnect.Intent{{ServiceID: serviceA, PairID: pair}, {ServiceID: serviceB, PairID: pair}, {ServiceID: serviceA, PairID: protocol.NewID()}}
	key := func(serviceID, pairID string) string { return serviceID + ":" + pairID }
	var mu sync.Mutex
	calls := map[string]int{}
	clock := make(chan time.Time)
	engine := autoconnect.New(autoconnect.Options{
		Intents: func(context.Context) ([]autoconnect.Intent, error) { return intents, nil },
		Stage: func(serviceID, pairID string) autoconnect.ConnectionState {
			mu.Lock()
			defer mu.Unlock()
			if pairID != pair && calls[key(serviceID, pairID)] > 1 {
				return autoconnect.ConnectionState{Stage: "connected"}
			}
			return autoconnect.ConnectionState{}
		},
		Connect: func(_ context.Context, serviceID, pairID string) error {
			mu.Lock()
			defer mu.Unlock()
			calls[key(serviceID, pairID)]++
			if pairID == pair {
				return errors.New("p2p.pair_revoked")
			}
			if calls[key(serviceID, pairID)] == 1 {
				return errors.New("p2p.peer_offline")
			}
			return nil
		},
		CodeOf: func(err error) string { return err.Error() },
		After:  func(time.Duration) <-chan time.Time { return clock },
	})
	host.reconnect = engine
	for _, serviceID := range []string{serviceA, serviceB} {
		client, err := controlplane.New(controlplane.Endpoints{
			HTTPSOrigin: "https://maintenance.test", WSSURL: "wss://maintenance.test/v1/signals", STUNAddress: "127.0.0.1:3478",
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		// No HTTP operation is performed: the configured client lets unknown
		// management methods reach their real default refusal instead of setup admission.
		host.accounts[serviceID] = &account{identity: controlplane.Identity{ServiceID: serviceID}, host: host, client: client}
	}
	engine.Reconcile(context.Background())
	for _, operation := range []string{"peer.autoconnect_reconcile", "peer.autoconnect_retry_now"} {
		payload, err := json.Marshal(scopedRequest{ServiceID: serviceA, Data: json.RawMessage(`{}`)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := host.Handle(context.Background(), operation, payload); err != nil {
			t.Fatal("ordinary maintenance refused", operation, err)
		}
	}
	for _, serviceID := range []string{serviceA, serviceB} {
		payload, err := json.Marshal(scopedRequest{ServiceID: serviceID, Data: json.RawMessage(`{}`)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := host.Handle(context.Background(), "peer.autoconnect_clear_refusals", payload); err == nil || err.Error() != "p2p.invalid_operation" {
			t.Fatal("removed reset operation was not unknown", serviceID, err)
		}
		if code, stopped := engine.Refusal(serviceID, pair); !stopped || code != "p2p.pair_revoked" {
			t.Fatal("ordinary maintenance cleared a terminal service", serviceID, code)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if calls[key(serviceA, pair)] != 1 || calls[key(serviceB, pair)] != 1 || calls[key(serviceA, intents[2].PairID)] != 2 {
		t.Fatal("maintenance retried terminal work or lost transient RetryNow", calls)
	}
}
