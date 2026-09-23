package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// desktopAttachment promotes exactly one authenticated endpoint client to the
// core's reverse-callback owner. Short-lived CLI clients continue to invoke
// core methods but cannot steal callbacks without the explicit attach RPC.
type desktopAttachment struct {
	mu        sync.Mutex
	peer      *localrpc.Peer
	host      *helper.Host
	fallback  helper.Main
	state     string
	stop      context.CancelFunc
	autostart core.Autostart
	handoff   bool
}

func newDesktopAttachment(host *helper.Host, fallback helper.Main, state string, stop context.CancelFunc, autostart core.Autostart) *desktopAttachment {
	return &desktopAttachment{host: host, fallback: fallback, state: state, stop: stop, autostart: autostart}
}

func (attachment *desktopAttachment) handlerFor(peer *localrpc.Peer, server *core.Serve) localrpc.Handler {
	return func(ctx context.Context, method string, payload json.RawMessage) (any, error) {
		if method == "core.desktop_attach" {
			var request struct{}
			if err := protocol.DecodeExact(payload, &request); err != nil {
				return nil, err
			}
			attachment.mu.Lock()
			defer attachment.mu.Unlock()
			if attachment.peer != nil && attachment.peer != peer {
				return nil, errors.New("p2p.owner_busy")
			}
			attachment.peer = peer
			attachment.handoff = false
			attachment.host.BindMain(peer)
			return struct {
				Attached bool `json:"attached"`
			}{true}, nil
		}
		if method == "core.desktop_handoff" {
			var request struct{}
			if err := protocol.DecodeExact(payload, &request); err != nil {
				return nil, err
			}
			attachment.mu.Lock()
			defer attachment.mu.Unlock()
			if attachment.peer != peer || !filepath.IsAbs(attachment.state) || attachment.stop == nil || server.Autostart == nil {
				return nil, errors.New("p2p.invalid_operation")
			}
			view, err := server.Autostart.Status(ctx)
			if err != nil {
				return nil, err
			}
			if view.Installed {
				return nil, errors.New("p2p.autostart_conflict")
			}
			// Closing the attached socket acknowledges the response and ends
			// this owner. Immediate cancellation could race the client's read.
			attachment.handoff = true
			return struct {
				Handoff bool `json:"handoff"`
			}{true}, nil
		}
		return server.Handle(ctx, method, payload)
	}
}

func (attachment *desktopAttachment) disconnected(peer *localrpc.Peer) {
	attachment.mu.Lock()
	stop := false
	wasAttached := attachment.peer == peer
	if attachment.peer == peer {
		stop = attachment.handoff
		attachment.peer = nil
		attachment.handoff = false
		attachment.host.BindMain(attachment.fallback)
	}
	attachment.mu.Unlock()
	if wasAttached && !stop && attachment.autostart != nil {
		// A GUI can crash without sending desktop_handoff. With autostart off,
		// retaining that detached headless owner would block the next GUI from
		// acquiring the state, so exit when the last desktop disappears.
		if status, err := attachment.autostart.Status(context.Background()); err == nil && !status.Installed {
			stop = true
		}
	}
	if stop {
		attachment.stop()
	}
}
