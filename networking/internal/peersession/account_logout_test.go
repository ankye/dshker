package peersession

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// This is the production local gateway/endpoint and the same public Manager
// fence used by Host.logout, not a real remote DSH/server-End proof.
func TestAccountLogoutFenceClosesRealGatewayAndRetainsJoin(t *testing.T) {
	for _, state := range []string{"active", "cancelled", "closed", "already-empty"} {
		t.Run(state, func(t *testing.T) {
			received := make(chan struct{})
			manager, pairID, dials := recoveryManager(t, func(active subscription) {
				for range active.Events() {
				}
				close(received)
			})
			link := recoveryIdleLink{messages: make(chan []byte), done: make(chan struct{})}
			mux, err := peer.NewMux(link, peer.StreamScope{AttemptID: "aabbccddeeff", Generation: 1, RuntimeGeneration: 73, Initiator: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { close(link.done); mux.Close() })
			endpoint, err := runtimebridge.NewEndpoint(mux, runtimebridge.Binding{Generation: 73, URL: "http://127.0.0.1:19473/?token=test-only-runtime-identity"})
			if err != nil {
				t.Fatal(err)
			}
			gateway, err := runtimebridge.OpenBrowserEndpoint(manager.ctx, endpoint)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(gateway.Close)
			manager.mu.Lock()
			manager.endpoints[pairID] = endpoint
			manager.inboundEndpoints = map[string]*runtimebridge.Endpoint{pairID: endpoint}
			manager.candidatesActive = true
			manager.mu.Unlock()
			switch state {
			case "cancelled":
				manager.cancel()
			case "closed":
				manager.Close()
			case "already-empty":
				manager.client.SetAccount("")
				manager.accountUserID = ""
			}
			completion, err := manager.FenceAccountForLogout()
			if state == "closed" {
				if err == nil || err.Error() != "p2p.helper_unavailable" {
					t.Fatal("closed local owner was disguised as successful logout", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if completion == nil {
				t.Fatal("local logout discarded its signaling join owner")
			}
			completion.Wait()
			completion.Wait()
			if manager.client.Account() != "" || manager.accountUserID != "" || manager.CandidatesActive() || manager.WorkbenchRequested(pairID) || len(manager.pins) != 0 || len(manager.endpoints) != 0 || len(manager.inboundEndpoints) != 0 || manager.signals != nil || dials.Load() != 1 {
				t.Fatal("local logout retained authority or dialed a replacement")
			}
			select {
			case <-gateway.Done():
			case <-time.After(2 * time.Second):
				t.Fatal("local logout did not close the actual old browser gateway")
			}
			for _, done := range []<-chan struct{}{endpoint.Done(), received} {
				select {
				case <-done:
				default:
					t.Fatal("logout completion returned before its actual gateway/endpoint/receive owner ended")
				}
			}
			again, againErr := manager.FenceAccountForLogout()
			if again == nil || state == "closed" && (againErr == nil || againErr.Error() != "p2p.helper_unavailable") || state != "closed" && againErr != nil {
				t.Fatal("repeated empty-target logout lost its completion or closed-state refusal", againErr)
			}
			again.Wait()
		})
	}
}

func TestAccountLogoutFenceWaitsAfterAccountUnlockAcrossClose(t *testing.T) {
	var accountMu sync.Mutex
	accountMu.Lock()
	locked := true
	defer func() {
		if locked {
			accountMu.Unlock()
		}
	}()
	entered, received := make(chan struct{}), make(chan struct{})
	manager, _, dials := recoveryManager(t, func(active subscription) {
		close(entered)
		accountMu.Lock()
		accountMu.Unlock()
		for range active.Events() {
		}
		close(received)
	})
	<-entered
	completion, err := manager.FenceAccountForLogout()
	if err != nil {
		t.Fatal(err)
	}
	manager.cancel()
	manager.Close()
	joined := make(chan struct{})
	go func() { completion.Wait(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("cancel/close abandoned the receive waiting on account.mu")
	default:
	}
	accountMu.Unlock()
	locked = false
	select {
	case <-joined:
	case <-time.After(2 * time.Second):
		t.Fatal("logout completion lost its receive join after account unlock")
	}
	select {
	case <-received:
	default:
		t.Fatal("logout completion did not join the old receive")
	}
	if dials.Load() != 1 {
		t.Fatal("local-only logout dialed after cancellation")
	}
	if _, err := manager.Connect(context.Background(), "aabbccddeeff", 1, true); err == nil {
		t.Fatal("closed/logout owner accepted new candidate authority")
	}
}
