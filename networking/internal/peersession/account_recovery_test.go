package peersession

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// The unit uses the production gateway/listener and Mux but no remote runtime:
// it proves retention of local owners, not live DSH traffic or server End.
type recoveryIdleLink struct {
	messages chan []byte
	done     chan struct{}
}

func (link recoveryIdleLink) Send([]byte) error       { return errors.New("test.idle_stream") }
func (link recoveryIdleLink) Messages() <-chan []byte { return link.messages }
func (link recoveryIdleLink) Done() <-chan struct{}   { return link.done }

func recoveryManager(t *testing.T, receive func(subscription)) (*Manager, string, *atomic.Int32) {
	t.Helper()
	manager := turnCredentialManager(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("local recovery fence unexpectedly issued HTTP") }))
	manager.ctx, manager.cancel = context.WithCancel(context.Background())
	manager.client.SetAccount(manager.accountUserID)
	manager.config.CoreInstanceID = protocol.NewNonce()
	manager.sessions, manager.inbound = map[string]*session{}, map[string]*session{}
	manager.candidates, manager.inboundCandidates = map[string]*session{}, map[string]*session{}
	_, pin := pinFixture()
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	manager.workbenches = map[string]bool{pin.Pair.PairID: true}
	dials := &atomic.Int32{}
	manager.subscribe = func(context.Context, string) (subscription, error) { dials.Add(1); return newFakeSubscription(), nil }
	var err error
	manager.signals, err = newSignaling(manager.ctx, manager.subscribe, manager.config.Device.DeviceID, receive)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	return manager, pin.Pair.PairID, dials
}

func TestAccountRecoverySameUserPreservesIntentGatewayRuntimeAndOwnedCleanup(t *testing.T) {
	manager, pairID, dials := recoveryManager(t, func(active subscription) {
		for range active.Events() {
		}
	})
	link := recoveryIdleLink{messages: make(chan []byte), done: make(chan struct{})}
	mux, err := peer.NewMux(link, peer.StreamScope{AttemptID: protocol.NewID(), Generation: 1, RuntimeGeneration: 73, Initiator: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { close(link.done); mux.Close() })
	binding := runtimebridge.Binding{Generation: 73, URL: "http://127.0.0.1:19473/?token=test-only-runtime-identity"}
	endpoint, err := runtimebridge.NewEndpoint(mux, binding)
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := runtimebridge.OpenBrowserEndpoint(manager.ctx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(gateway.Close)
	manager.endpoints[pairID] = endpoint
	manager.inboundEndpoints = map[string]*runtimebridge.Endpoint{pairID: endpoint}
	cleanupCtx, stopCleanup := context.WithCancel(manager.ctx)
	defer stopCleanup()
	job := &endCleanup{ctx: cleanupCtx, cancel: stopCleanup, done: make(chan struct{}), ticket: protocol.CandidateTicket{Lease: protocol.Lease{UserID: manager.accountUserID}}}
	manager.endJobs = map[string]*endCleanup{"owned-attempt": job}
	beforeURL, beforeDevice, beforeCore := gateway.URL, manager.config.Device, manager.config.CoreInstanceID
	completion, err := manager.FenceAccountForCertificateRecovery(manager.accountUserID)
	if err != nil {
		t.Fatal(err)
	}
	completion.Wait()
	if manager.CandidatesActive() || manager.signals != nil || dials.Load() != 1 || !manager.WorkbenchRequested(pairID) || manager.endpoints[pairID] != endpoint || manager.inboundEndpoints[pairID] != endpoint || manager.endJobs["owned-attempt"] != job || cleanupCtx.Err() != nil || manager.config.Device.DeviceID != beforeDevice.DeviceID || manager.config.CoreInstanceID != beforeCore {
		t.Fatal("same-user recovery lost intent/gateway/device/core/cleanup or dialed")
	}
	if got, err := endpoint.Binding(); err != nil || got != binding || gateway.URL != beforeURL || endpoint.LocalURL() != beforeURL || endpoint.CurrentMux() != mux {
		t.Fatal("same-user recovery changed the opened runtime attachment")
	}
	select {
	case <-gateway.Done():
		t.Fatal("same-user recovery closed its stable browser gateway")
	default:
	}
	select {
	case <-endpoint.Done():
		t.Fatal("same-user recovery closed its endpoint")
	default:
	}
	if _, err := manager.Connect(context.Background(), pairID, 2, false); err == nil || err.Error() != "p2p.candidate_unsupported" {
		t.Fatal("pending recovery admitted a candidate", err)
	}
}

func TestAccountRecoveryDetachesUnderAccountLockAndJoinsOnlyAfterUnlock(t *testing.T) {
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
	type answer struct {
		completion *AccountRecoveryCompletion
		err        error
	}
	returned := make(chan answer, 1)
	go func() {
		completion, err := manager.FenceAccountForCertificateRecovery(manager.accountUserID)
		returned <- answer{completion, err}
	}()
	var completion *AccountRecoveryCompletion
	select {
	case result := <-returned:
		if result.err != nil {
			t.Fatal(result.err)
		}
		completion = result.completion
	case <-time.After(2 * time.Second):
		t.Fatal("local fence tried to join a receive/emit blocked on account.mu")
	}
	joined := make(chan struct{})
	go func() { completion.Wait(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("completion abandoned the blocked receive worker")
	default:
	}
	accountMu.Unlock()
	locked = false
	select {
	case <-joined:
	case <-time.After(2 * time.Second):
		t.Fatal("detached signaling owner was not joined after account unlock")
	}
	select {
	case <-received:
	default:
		t.Fatal("completion returned before old receive stopped")
	}
	if dials.Load() != 1 || manager.signals != nil || manager.CandidatesActive() {
		t.Fatal("local fence redialed or retained registration")
	}
}

func TestAccountRecoveryChangeOrLogoutRetiresOnlyPreviousAccountScope(t *testing.T) {
	for _, userID := range []string{protocol.NewID(), ""} {
		t.Run(userID, func(t *testing.T) {
			manager, pairID, dials := recoveryManager(t, func(active subscription) {
				for range active.Events() {
				}
			})
			endpoint := &runtimebridge.Endpoint{}
			manager.endpoints[pairID] = endpoint
			completion, err := manager.FenceAccountForCertificateRecovery(userID)
			if err != nil {
				t.Fatal(err)
			}
			completion.Wait()
			if manager.client.Account() != userID || manager.accountUserID != userID || manager.CandidatesActive() || manager.signals != nil || len(manager.pins) != 0 || manager.WorkbenchRequested(pairID) || len(manager.endpoints) != 0 || dials.Load() != 1 {
				t.Fatal("changed-account recovery retained the previous authorization or dialed")
			}
			select {
			case <-endpoint.Done():
			default:
				t.Fatal("previous account's gateway was not retired")
			}
		})
	}
}

func TestRecoverySignalingClosingBarrierPreventsLateWorkerStarts(t *testing.T) {
	owner, err := newSignaling(context.Background(), func(context.Context, string) (subscription, error) { return newFakeSubscription(), nil }, "test-device", func(active subscription) {
		for range active.Events() {
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	var dispatch sync.WaitGroup
	var callbacks atomic.Int32
	for index := 0; index < 100; index++ {
		dispatch.Add(1)
		go func() { defer dispatch.Done(); owner.startWorker(func() { callbacks.Add(1) }) }()
	}
	owner.closeAndWait()
	dispatch.Wait()
	before := callbacks.Load()
	owner.startWorker(func() { callbacks.Add(1) })
	owner.closeAndWait()
	if callbacks.Load() != before {
		t.Fatal("worker started after recovery closing/Wait barrier")
	}
}

func TestAccountRecoveryCompletionRetainsJoinAcrossCancellationAndManagerClose(t *testing.T) {
	for _, operation := range []string{"cancel", "close"} {
		t.Run(operation, func(t *testing.T) {
			var accountMu sync.Mutex
			accountMu.Lock()
			locked := true
			defer func() {
				if locked {
					accountMu.Unlock()
				}
			}()
			entered, received := make(chan struct{}), make(chan struct{})
			manager, _, _ := recoveryManager(t, func(active subscription) {
				close(entered)
				accountMu.Lock()
				accountMu.Unlock()
				for range active.Events() {
				}
				close(received)
			})
			<-entered
			completion, err := manager.FenceAccountForCertificateRecovery(manager.accountUserID)
			if err != nil {
				t.Fatal(err)
			}
			if operation == "cancel" {
				manager.cancel()
			} else {
				manager.Close()
			}
			joined := make(chan struct{})
			go func() { completion.Wait(); close(joined) }()
			select {
			case <-joined:
				t.Fatal("cancel/close abandoned the old blocked callback")
			default:
			}
			accountMu.Unlock()
			locked = false
			select {
			case <-joined:
			case <-time.After(2 * time.Second):
				t.Fatal("cancel/close lost the retained signaling join owner")
			}
			select {
			case <-received:
			default:
				t.Fatal("completion returned before old callback finished")
			}
		})
	}
}

func TestRecoverySignalingWorkerMayCloseWithoutSelfJoin(t *testing.T) {
	owner, err := newSignaling(context.Background(), func(context.Context, string) (subscription, error) { return newFakeSubscription(), nil }, "test-device", func(active subscription) {
		for range active.Events() {
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	owner.startWorker(func() { owner.close(); close(closed) })
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("ordinary worker-owned close tried to join itself")
	}
	owner.closeAndWait()
}
