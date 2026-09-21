package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
)

type testHeadlessMain struct{}

type handoffAutostart struct{ installed bool }

func (*handoffAutostart) Install(context.Context) error { return errors.New("p2p.invalid_operation") }
func (authority *handoffAutostart) Remove(context.Context) error {
	authority.installed = false
	return nil
}
func (authority *handoffAutostart) Status(context.Context) (core.AutostartView, error) {
	return core.AutostartView{Installed: authority.installed, Supported: true, Mechanism: "test"}, nil
}

func (testHeadlessMain) Call(context.Context, string, any) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func TestDesktopAttachmentPromotesOnlyAuthenticatedClientAndDetaches(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	host := helper.New(ctx)
	fallback := testHeadlessMain{}
	host.BindMain(fallback)
	attachment := newDesktopAttachment(host, fallback, t.TempDir(), cancel, nil)
	server := &core.Serve{}

	serverConn, clientConn := net.Pipe()
	serverPeer := localrpc.NewWithPeer(ctx, serverConn, func(peer *localrpc.Peer) localrpc.Handler {
		return attachment.handlerFor(peer, server)
	})
	callbacks := make(chan string, 1)
	clientPeer := localrpc.New(ctx, clientConn, func(_ context.Context, method string, _ json.RawMessage) (any, error) {
		callbacks <- method
		return struct{}{}, nil
	})
	defer serverPeer.Close()
	defer clientPeer.Close()
	if _, err := clientPeer.Call(ctx, "core.desktop_attach", map[string]bool{"unexpected": true}); err == nil || err.Error() != "p2p.invalid_fields" {
		t.Fatalf("malformed attach = %v", err)
	}
	answer, err := clientPeer.Call(ctx, "core.desktop_attach", struct{}{})
	if err != nil || string(answer) != `{"attached":true}` {
		t.Fatalf("attach = %s, %v", answer, err)
	}
	attachment.mu.Lock()
	attached := attachment.peer
	attachment.mu.Unlock()
	if attached != serverPeer {
		t.Fatal("wrong callback owner attached")
	}
	if _, err := attached.Call(ctx, "peer.state", struct{}{}); err != nil {
		t.Fatalf("reverse callback: %v", err)
	}
	select {
	case method := <-callbacks:
		if method != "peer.state" {
			t.Fatalf("callback = %q", method)
		}
	case <-ctx.Done():
		t.Fatal("attached desktop received no callback")
	}

	otherServer, otherClient := net.Pipe()
	otherPeer := localrpc.NewWithPeer(ctx, otherServer, func(peer *localrpc.Peer) localrpc.Handler {
		return attachment.handlerFor(peer, server)
	})
	otherCaller := localrpc.New(ctx, otherClient, nil)
	defer otherPeer.Close()
	defer otherCaller.Close()
	if _, err := otherCaller.Call(ctx, "core.desktop_attach", struct{}{}); err == nil || err.Error() != "p2p.owner_busy" {
		t.Fatalf("second desktop = %v, want owner_busy", err)
	}
	attachment.disconnected(serverPeer)
	attachment.mu.Lock()
	stillAttached := attachment.peer
	attachment.mu.Unlock()
	if stillAttached != nil {
		t.Fatal("closed desktop remained callback owner")
	}
	if _, err := otherCaller.Call(ctx, "core.desktop_attach", struct{}{}); err != nil {
		t.Fatalf("attach after detach: %v", err)
	}
}

func TestDesktopHandoffRequiresAttachedPeerAndDisabledRegistration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	host := helper.New(ctx)
	defer host.Close()
	registration := &handoffAutostart{installed: true}
	server := &core.Serve{Autostart: registration}
	handedOff := make(chan struct{})
	attachment := newDesktopAttachment(host, testHeadlessMain{}, t.TempDir(), func() { close(handedOff) }, registration)
	serverConn, clientConn := net.Pipe()
	serverPeer := localrpc.NewWithPeer(ctx, serverConn, func(peer *localrpc.Peer) localrpc.Handler {
		return attachment.handlerFor(peer, server)
	})
	clientPeer := localrpc.New(ctx, clientConn, nil)
	defer serverPeer.Close()
	defer clientPeer.Close()
	if _, err := clientPeer.Call(ctx, "core.desktop_handoff", struct{}{}); err == nil || err.Error() != "p2p.invalid_operation" {
		t.Fatalf("unattached handoff = %v", err)
	}
	if _, err := clientPeer.Call(ctx, "core.desktop_attach", struct{}{}); err != nil {
		t.Fatalf("attach = %v", err)
	}
	if _, err := clientPeer.Call(ctx, "core.desktop_handoff", struct{}{}); err == nil || err.Error() != "p2p.autostart_conflict" {
		t.Fatalf("handoff while installed = %v", err)
	}
	if _, err := clientPeer.Call(ctx, "core.autostart_disable", struct{}{}); err != nil {
		t.Fatalf("disable = %v", err)
	}
	if _, err := clientPeer.Call(ctx, "core.desktop_handoff", map[string]bool{"unexpected": true}); err == nil || err.Error() != "p2p.invalid_fields" {
		t.Fatalf("malformed handoff = %v", err)
	}
	response, err := clientPeer.Call(ctx, "core.desktop_handoff", struct{}{})
	if err != nil || string(response) != `{"handoff":true}` {
		t.Fatalf("handoff = %s, %v", response, err)
	}
	select {
	case <-handedOff:
		t.Fatal("headless owner stopped before desktop disconnected")
	default:
	}
	clientPeer.Close()
	attachment.disconnected(serverPeer)
	select {
	case <-handedOff:
	case <-ctx.Done():
		t.Fatal("handoff did not stop headless owner")
	}
}

func TestDetachedDesktopStopsUnregisteredHeadlessOwner(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	host := helper.New(ctx)
	defer host.Close()
	registration := &handoffAutostart{installed: false}
	stopped := make(chan struct{})
	attachment := newDesktopAttachment(host, testHeadlessMain{}, t.TempDir(), func() { close(stopped) }, registration)
	server := &core.Serve{Autostart: registration}
	serverConn, clientConn := net.Pipe()
	serverPeer := localrpc.NewWithPeer(ctx, serverConn, func(peer *localrpc.Peer) localrpc.Handler {
		return attachment.handlerFor(peer, server)
	})
	clientPeer := localrpc.New(ctx, clientConn, nil)
	defer serverPeer.Close()
	if _, err := clientPeer.Call(ctx, "core.desktop_attach", struct{}{}); err != nil {
		t.Fatal(err)
	}
	clientPeer.Close()
	attachment.disconnected(serverPeer)
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("detached unregistered owner remained running")
	}
}
