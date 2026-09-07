package peersession

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestDisconnectCancelsPendingBegin(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	requestCancelled := make(chan struct{})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/attempt" {
			t.Errorf("unexpected operation %s", r.URL.Path)
		}
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Errorf("request body read: %v", err)
			return
		}
		entered <- struct{}{}
		select {
		case <-r.Context().Done():
			close(requestCancelled)
		case <-release:
		}
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	defer close(release)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := controlplane.New(controlplane.Endpoints{HTTPSOrigin: server.URL, WSSURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/signals", STUNAddress: "127.0.0.1:3478"}, roots)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	manager, pin := pinFixture()
	manager.ctx, manager.cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer manager.cancel()
	manager.client, manager.sessions = client, make(map[string]*session)
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, err := manager.Connect(manager.ctx, pin.Pair.PairID, 1); result <- err }()
	select {
	case <-entered:
	case <-manager.ctx.Done():
		t.Fatal("Begin did not reach server")
	}
	if _, err := manager.Connect(manager.ctx, pin.Pair.PairID, 2); err == nil || err.Error() != "p2p.connection_busy" {
		t.Fatalf("duplicate admitted: %v", err)
	}
	if err := manager.Disconnect(pin.Pair.PairID); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("cancelled Begin reported success")
	}
	manager.mu.Lock()
	remaining := len(manager.sessions)
	manager.mu.Unlock()
	if remaining != 0 {
		t.Fatal("Disconnect returned before reservation cleanup")
	}
	select {
	case <-requestCancelled:
	case <-manager.ctx.Done():
		t.Fatal("outgoing Begin HTTP request remained active after disconnect")
	}
}

func TestInvalidationRejectsLateOwnerBinding(t *testing.T) {
	manager, pin := pinFixture()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	child, stop := context.WithCancel(ctx)
	defer stop()
	connection := &session{ctx: child, cancel: stop, transport: &peer.Transport{}, lease: protocol.Lease{ToDeviceID: manager.config.Device.DeviceID}}
	manager.sessions = map[string]*session{pin.Pair.PairID: connection}
	entered, release := make(chan struct{}), make(chan struct{})
	manager.owner = func(context.Context, string) (runtimebridge.Binding, error) {
		close(entered)
		<-release
		return runtimebridge.Binding{Generation: 3, URL: "http://127.0.0.1:4567/?token=secret"}, nil
	}
	result := make(chan error, 1)
	go func() {
		binding, err := manager.runtimeOwner(connection)(ctx, pin.Pair.PairID)
		if binding.URL != "" {
			t.Error("stale credential escaped")
		}
		result <- err
	}()
	<-entered
	manager.InvalidateRuntime(3)
	close(release)
	if err := <-result; err == nil || err.Error() != "p2p.runtime_invalidated" {
		t.Fatalf("late owner result accepted: %v", err)
	}
}

func TestInvalidationPreservesOtherRuntimeAndOutgoingPeer(t *testing.T) {
	manager, pin := pinFixture()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	incoming := newSession(ctx)
	incoming.transport = &peer.Transport{}
	incoming.lease.ToDeviceID = manager.config.Device.DeviceID
	incoming.result.State.RuntimeGeneration = 8
	outgoing := newSession(ctx)
	outgoing.transport = &peer.Transport{}
	outgoing.lease.ToDeviceID = pin.Target.DeviceID
	outgoing.result.State.RuntimeGeneration = 7
	manager.sessions = map[string]*session{"incoming": incoming, "outgoing": outgoing}
	manager.InvalidateRuntime(7)
	if incoming.ctx.Err() != nil || outgoing.ctx.Err() != nil {
		t.Fatal("invalidation cancelled an unrelated runtime")
	}
	manager.InvalidateRuntime(8)
	if incoming.ctx.Err() == nil || outgoing.ctx.Err() != nil {
		t.Fatal("invalidation did not remain scoped to the local runtime")
	}
}
