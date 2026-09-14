package integration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/coder/websocket"
)

// startStubDSH serves the same contract the real DSH Web does for a peer:
// a token exchange that sets a session cookie, and the multiplexed websocket
// endpoint. A stub keeps this test independent of a Harness checkout, so it
// runs the same way on Windows, where the real-DSH diagnostics need an npm
// dependency that machine does not have.
func startStubDSH(t *testing.T) (string, func()) {
	t.Helper()
	const token = "stub-runtime-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/remote.mux" {
			connection, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer connection.CloseNow()
			kind, data, err := connection.Read(r.Context())
			if err != nil {
				return
			}
			_ = connection.Write(r.Context(), kind, data)
			return
		}
		if r.URL.Query().Get("token") == token {
			http.SetCookie(w, &http.Cookie{Name: "dsh-session", Value: "stub-cookie", Path: "/", HttpOnly: true})
			w.Header().Set("Location", "/")
			w.WriteHeader(http.StatusSeeOther)
			return
		}
		if cookie, err := r.Cookie("dsh-session"); err == nil && cookie.Value == "stub-cookie" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("<!doctype html><title>stub dsh</title>"))
			return
		}
		http.Error(w, "dsh web authentication required; reopen the URL printed by dsh web.", http.StatusUnauthorized)
	}))
	return server.URL + "/?token=" + token, server.Close
}

// drain keeps a state channel from filling across many cycles; the assertion
// is about the address and the resources, not about every emitted state.
func drain(channel chan peersession.State) {
	for {
		select {
		case <-channel:
		default:
			return
		}
	}
}

// describe reports the states a peer emitted, so a failing cycle says which
// stage broke instead of only the refusal code.
func describe(channel chan peersession.State) string {
	report := ""
	for {
		select {
		case state := <-channel:
			report += fmt.Sprintf("[%s %s %s] ", state.Stage, state.Error, state.Path.Protocol)
		default:
			return report
		}
	}
}

// Repeated disconnects are the case a user actually hits: a flaky network, a
// laptop lid, a peer that restarts. Each cycle must come back on the SAME
// address, and the cycles must not accumulate listeners or goroutines — a
// leaked gateway per reconnect would exhaust ports long before the user
// noticed anything else.
//
// Both role assignments run, because the two sides are not the same code: the
// initiator owns the loopback gateway (the address a browser holds) while the
// responder serves over a replaceable listener. Testing only one assignment
// would leave the other side's reconnect path unproven.
func TestManagerRepeatedReconnectKeepsOneAddress(t *testing.T) {
	for _, roles := range []struct {
		name               string
		initiator, runtime int
	}{
		{"initiator is the first device", 0, 1},
		{"initiator is the second device", 1, 0},
	} {
		t.Run(roles.name, func(t *testing.T) {
			reconnectCycles(t, roles.initiator, roles.runtime)
		})
	}
}

// reconnectCycles drives `cycles` connect/disconnect rounds with the given role
// assignment and asserts the address and the resources survive all of them.
func reconnectCycles(t *testing.T, initiator, runtimeOwner int) {
	t.Helper()
	runtimeURL, stopRuntime := startStubDSH(t)
	defer stopRuntime()
	var bindingMu sync.Mutex
	binding := runtimebridge.Binding{Generation: 1, URL: runtimeURL}
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 180*time.Second)
	defer cancel()
	var managers [2]*peersession.Manager
	var states [2]chan peersession.State
	for _, i := range []int{1, 0} {
		config := f.config[i]
		states[i] = make(chan peersession.State, 4096)
		owner := func(context.Context, string) (runtimebridge.Binding, error) {
			if i != runtimeOwner {
				return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_owner")
			}
			bindingMu.Lock()
			defer bindingMu.Unlock()
			return binding, nil
		}
		// Presence is reported per account, exactly as the shell configures its core.
		f.devices[i].SetAccount(config.Device.UserID)
		manager, err := peersession.New(ctx, f.devices[i], peersession.Config{Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device, PrivateKey: config.Private}, []controlplane.PairIdentity{config.Pin}, owner, func(state peersession.State) { states[i] <- state })
		must(t, err)
		managers[i] = manager
		defer manager.Close()
	}
	pairID := f.config[initiator].Pin.Pair.PairID
	state := managers[initiator]

	const cycles = 20
	var first string
	addresses := make(map[string]int)
	baseline := 0
	for cycle := 1; cycle <= cycles; cycle++ {
		// Paced below the coordinator's documented 20 requests/source/second
		// limit, the way the runtime session test does it.
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		connected, err := state.Connect(ctx, pairID, uint64(cycle))
		if err != nil {
			t.Fatalf("cycle %d connect: %v\n  A: %s\n  B: %s", cycle, err, describe(states[0]), describe(states[1]))
		}
		if connected.State.Stage != "ready" || connected.State.PairID != pairID {
			t.Fatalf("cycle %d reported %+v", cycle, connected.State)
		}
		if path := connected.State.Path; path.Protocol != "udp" || path.LocalType == "" || path.RemoteType == "" || path.LocalType == "relay" || path.RemoteType == "relay" {
			t.Fatalf("cycle %d did not select direct UDP: %+v", cycle, path)
		}
		if first == "" {
			first = connected.URL
			// Sampled once a connection exists, so one-time setup goroutines are
			// not counted as growth.
			runtime.GC()
			baseline = runtime.NumGoroutine()
		}
		addresses[connected.URL]++
		if connected.URL != first {
			t.Fatalf("cycle %d moved the address: %s -> %s", cycle, first, connected.URL)
		}
		if err := runtimebridge.Probe(ctx, connected.URL); err != nil {
			t.Fatalf("cycle %d probe: %v", cycle, err)
		}
		if err := state.Disconnect(pairID); err != nil {
			t.Fatalf("cycle %d disconnect: %v", cycle, err)
		}
		drain(states[0])
		drain(states[1])
	}
	if len(addresses) != 1 {
		t.Fatalf("%d cycles used %d addresses: %v", cycles, len(addresses), addresses)
	}
	if addresses[first] != cycles {
		t.Fatalf("the stable address served %d of %d cycles", addresses[first], cycles)
	}

	// Settle, then check the cycles did not accumulate goroutines.
	time.Sleep(3 * time.Second)
	runtime.GC()
	final := runtime.NumGoroutine()
	if final > baseline+40 {
		t.Fatalf("goroutines grew from %d to %d across %d reconnects", baseline, final, cycles)
	}
	t.Logf("%d reconnects, one stable address, goroutines %d -> %d", cycles, baseline, final)
}
