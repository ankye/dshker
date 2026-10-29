package main

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
)

func TestIsolatedDesktopLifetimeDoesNotInspectGlobalAutostart(t *testing.T) {
	for _, mode := range []string{"handoff", "disconnect"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv(secretNamespaceEnvironment, "regression-private-lifetime")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			host := helper.New(ctx)
			defer host.Close()
			global := &observedAutostart{}
			server := &core.Serve{Autostart: autostartForProfile(global)}
			stopped := make(chan struct{})
			attachment := newDesktopAttachment(host, testHeadlessMain{}, t.TempDir(), func() { close(stopped) }, global)
			// Profile selection is immutable once this composition is admitted.
			t.Setenv(secretNamespaceEnvironment, "")
			serverConn, clientConn := net.Pipe()
			serverPeer := localrpc.NewWithPeer(ctx, serverConn, func(peer *localrpc.Peer) localrpc.Handler {
				return attachment.handlerFor(peer, server)
			})
			client := localrpc.New(ctx, clientConn, nil)
			defer serverPeer.Close()
			defer client.Close()
			if _, err := client.Call(ctx, "core.desktop_handoff", struct{}{}); err == nil || err.Error() != "p2p.invalid_operation" {
				t.Fatalf("unattached isolated handoff = %v", err)
			}
			for _, method := range []string{"core.autostart_status", "core.autostart_enable", "core.autostart_disable"} {
				if _, err := client.Call(ctx, method, struct{}{}); err == nil || err.Error() != "p2p.autostart_unsupported" {
					t.Fatalf("public %s invented system status: %v", method, err)
				}
			}
			if _, err := client.Call(ctx, "core.desktop_attach", struct{}{}); err != nil {
				t.Fatal(err)
			}
			if mode == "handoff" {
				if _, err := client.Call(ctx, "core.desktop_handoff", map[string]bool{"unexpected": true}); err == nil || err.Error() != "p2p.invalid_fields" {
					t.Fatalf("malformed isolated handoff = %v", err)
				}
				answer, err := client.Call(ctx, "core.desktop_handoff", struct{}{})
				if err != nil || string(answer) != `{"handoff":true}` {
					t.Fatalf("isolated handoff was not acknowledged: %s, %v", answer, err)
				}
				select {
				case <-stopped:
					t.Fatal("isolated core stopped before its handoff acknowledgement was read")
				default:
				}
			}
			client.Close()
			attachment.disconnected(serverPeer)
			select {
			case <-stopped:
			case <-ctx.Done():
				t.Fatal("isolated core outlived its attached desktop")
			}
			if global.calls != 0 {
				t.Fatal("private isolated lifetime inspected global autostart")
			}
		})
	}
}
