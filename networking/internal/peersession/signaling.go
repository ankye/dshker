package peersession

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// subscription is the part of a control-plane connection the manager needs.
//
// It exists so the reconnect behaviour below can be tested without a running
// coordinator: production passes a *controlplane.Signals, tests pass a fake that
// can be killed on demand.
type subscription interface {
	Events() <-chan controlplane.SignalEvent
	Done() <-chan struct{}
	Send(ctx context.Context, signal protocol.Signal) error
	Close()
}

// subscribeFunc dials the coordinator and registers this device for attempts
// and signals.
type subscribeFunc func(ctx context.Context, deviceID string) (subscription, error)

// Reconnect pacing. The first retry is quick because the common loss is a
// coordinator redeploy or a momentary network change; the cap keeps a
// coordinator that is down for a long time from being hammered by every
// launcher on the fleet.
const (
	signalingRetryFloor = time.Second
	signalingRetryCeil  = 30 * time.Second
)

// signaling owns the coordinator subscription for the manager's whole lifetime.
//
// A subscription is not a one-shot resource: the websocket dies on a network
// change, a laptop sleeping, a coordinator restart, or a half-open connection
// that only a ping can detect. Without this supervisor the manager kept the
// dead subscription, stopped receiving attempts and signals, and never told
// anyone — P2P stayed dead until the user restarted the application, while the
// shell went on showing a healthy device. Recovery here is in-process: on loss
// the supervisor marks signalling down (so a new attempt fails immediately with
// a truthful code instead of hanging until its deadline), then re-subscribes with
// capped exponential backoff until it succeeds or the manager shuts down.
type signaling struct {
	ctx    context.Context
	cancel context.CancelFunc
	dial   subscribeFunc
	device string
	// receive is started for every subscription the supervisor installs.
	receive func(subscription)

	mu     sync.Mutex
	active subscription
	down   bool
	closed bool
}

func newSignaling(ctx context.Context, dial subscribeFunc, deviceID string, receive func(subscription)) (*signaling, error) {
	child, cancel := context.WithCancel(ctx)
	owner := &signaling{ctx: child, cancel: cancel, dial: dial, device: deviceID, receive: receive}
	first, err := dial(child, deviceID)
	if err != nil {
		cancel()
		return nil, err
	}
	owner.mu.Lock()
	owner.active = first
	owner.mu.Unlock()
	go owner.receive(first)
	go owner.supervise()
	return owner, nil
}

// current reports the live subscription, and whether signalling is usable.
func (owner *signaling) current() (subscription, bool) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.closed || owner.down || owner.active == nil {
		return nil, false
	}
	return owner.active, true
}

// send refuses at once while signalling is down, so a connect attempt the
// coordinator cannot deliver is reported as a signalling failure instead of
// waiting out its deadline and surfacing as a transport failure.
func (owner *signaling) send(ctx context.Context, signal protocol.Signal) error {
	active, ok := owner.current()
	if !ok {
		return errors.New("p2p.server_unavailable")
	}
	return active.Send(ctx, signal)
}

func (owner *signaling) close() {
	owner.mu.Lock()
	if owner.closed {
		owner.mu.Unlock()
		return
	}
	owner.closed = true
	active := owner.active
	owner.active = nil
	owner.mu.Unlock()
	owner.cancel()
	if active != nil {
		active.Close()
	}
}

// supervise replaces a lost subscription with backoff until the manager ends.
func (owner *signaling) supervise() {
	for {
		active, ok := owner.current()
		if !ok {
			return
		}
		select {
		case <-owner.ctx.Done():
			return
		case <-active.Done():
		}
		owner.markDown()
		if !owner.replace() {
			return
		}
	}
}

// replace re-subscribes after a loss, returning false when the manager is done.
func (owner *signaling) replace() bool {
	delay := signalingRetryFloor
	for {
		select {
		case <-owner.ctx.Done():
			return false
		case <-time.After(delay):
		}
		next, err := owner.dial(owner.ctx, owner.device)
		if err != nil {
			if delay < signalingRetryCeil {
				delay *= 2
				if delay > signalingRetryCeil {
					delay = signalingRetryCeil
				}
			}
			continue
		}
		owner.mu.Lock()
		if owner.closed {
			owner.mu.Unlock()
			next.Close()
			return false
		}
		owner.active = next
		owner.down = false
		owner.mu.Unlock()
		go owner.receive(next)
		return true
	}
}

func (owner *signaling) markDown() {
	owner.mu.Lock()
	owner.down = true
	owner.mu.Unlock()
}

// isDown reports whether the coordinator connection is currently lost.
func (owner *signaling) isDown() bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.down
}
