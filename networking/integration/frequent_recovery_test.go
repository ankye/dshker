package integration

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// TestManagersAlternateOfflineAndRecover exercises real presence transitions,
// not only disconnecting an established transport. Each device is closed and
// recreated four times while the other device stays up and reconnects to it.
// Repeating the same dial direction also forces the long-lived gateway to
// replace its session while the superseded run is still unwinding.
func TestManagersAlternateOfflineAndRecover(t *testing.T) {
	runtimeURL, stopRuntime := startStubDSH(t)
	defer stopRuntime()

	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 150*time.Second)
	defer cancel()

	newManager := func(index int) *peersession.Manager {
		config := f.config[index]
		f.devices[index].SetAccount(config.Device.UserID)
		manager, err := peersession.New(
			ctx,
			f.devices[index],
			peersession.Config{
				Endpoints:  config.Endpoints,
				Authority:  config.Authority,
				Device:     config.Device,
				PrivateKey: config.Private,
			},
			[]controlplane.PairIdentity{config.Pin},
			func(context.Context, string) (runtimebridge.Binding, error) {
				return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
			},
			func(peersession.State) {},
		)
		must(t, err)
		return manager
	}

	managers := [2]*peersession.Manager{newManager(0), newManager(1)}
	defer func() {
		for _, manager := range managers {
			if manager != nil {
				manager.Close()
			}
		}
	}()

	pairID := f.config[0].Pin.Pair.PairID
	generation := uint64(0)
	stableURLs := [2]string{}
	attempts := make(map[string]struct{})

	connect := func(dialer int) {
		generation++
		connected, err := managers[dialer].Connect(ctx, pairID, generation)
		if err != nil {
			t.Fatalf("device %d generation %d reconnect: %v", dialer, generation, err)
		}
		if connected.State.Stage != "ready" || connected.State.Generation != generation || connected.URL == "" {
			t.Fatalf("device %d generation %d reported %+v", dialer, generation, connected)
		}
		if !directUDP(connected.State.Path) {
			t.Fatalf("device %d generation %d did not select direct UDP: %+v", dialer, generation, connected.State.Path)
		}
		if _, duplicate := attempts[connected.State.AttemptID]; duplicate {
			t.Fatalf("generation %d reused attempt %s", generation, connected.State.AttemptID)
		}
		attempts[connected.State.AttemptID] = struct{}{}
		if stableURLs[dialer] == "" {
			stableURLs[dialer] = connected.URL
		} else if connected.URL != stableURLs[dialer] {
			t.Fatalf("device %d gateway moved across recovery: %s -> %s", dialer, stableURLs[dialer], connected.URL)
		}
		must(t, runtimebridge.Probe(ctx, connected.URL))
		// A superseded run may finish after Connect returns. Probe once more after
		// it has had time to unwind so stale cleanup cannot hide behind readiness.
		time.Sleep(250 * time.Millisecond)
		must(t, runtimebridge.Probe(ctx, connected.URL))
	}

	connect(0)
	const restartsPerDevice = 4
	for _, direction := range []struct {
		dialer int
		remote int
	}{{dialer: 0, remote: 1}, {dialer: 1, remote: 0}} {
		for restart := 1; restart <= restartsPerDevice; restart++ {
			managers[direction.remote].Close()
			managers[direction.remote] = nil
			waitFixturePresence(t, f, direction.remote, "offline")

			managers[direction.remote] = newManager(direction.remote)
			waitFixturePresence(t, f, direction.remote, "online")
			// Keep the local fixture under the coordinator's per-source admission
			// budget; this is not a retry after a refusal.
			time.Sleep(time.Second)
			connect(direction.dialer)
		}
	}

	if len(attempts) != 1+2*restartsPerDevice {
		t.Fatalf("got %d unique attempts, want %d", len(attempts), 1+2*restartsPerDevice)
	}
	t.Logf("both devices recovered from %d real offline/online cycles; attempts=%d", 2*restartsPerDevice, len(attempts))
}

func directUDP(path peer.DirectPath) bool {
	return path.Protocol == "udp" && path.LocalType != "" && path.RemoteType != "" && path.LocalType != "relay" && path.RemoteType != "relay"
}

func waitFixturePresence(t *testing.T, f *fixture, deviceIndex int, expected string) {
	t.Helper()
	deviceID := f.config[deviceIndex].Device.DeviceID
	pairID := f.config[deviceIndex].Pin.Pair.PairID
	observer := f.devices[1-deviceIndex]
	deadline := time.Now().Add(10 * time.Second)
	last := ""
	var lastErr error
	for time.Now().Before(deadline) {
		pin, err := observer.PairIdentity(f.ctx, pairID)
		if err == nil {
			lastErr = nil
			switch deviceID {
			case pin.Initiator.DeviceID:
				last = pin.Initiator.Presence
			case pin.Target.DeviceID:
				last = pin.Target.Presence
			default:
				t.Fatalf("pair %s does not contain device %s", pairID, deviceID)
			}
			if last == expected {
				return
			}
		} else {
			lastErr = err
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("device %d presence did not become %s (last=%s, error=%v)", deviceIndex, expected, last, lastErr)
}
