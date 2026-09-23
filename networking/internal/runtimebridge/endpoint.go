package runtimebridge

import (
	"errors"
	"sync"

	"github.com/ankye/dshker/networking/internal/peer"
)

// Endpoint is the live attachment a browser gateway dials through.
//
// A direct path does not survive forever: a network change, a sleeping
// machine or a peer restart ends the session, and the shell reconnects. If
// the gateway died with the session, its loopback port died too, so every
// reconnect handed the user a new URL — unusable for a browser tab left open
// on the address. The endpoint decouples the two: the gateway keeps its port
// and its URL for as long as the pair is meant to be reachable, while the
// session underneath is replaced as often as needed.
type Endpoint struct {
	mu      sync.RWMutex
	mux     *peer.Mux
	binding Binding
	closed  bool
	done    chan struct{}
	// localURL is the address this machine serves the peer's runtime on — the
	// gateway's own loopback URL, not the peer's. It is what the shell hands a
	// browser and what a caller must report as the connection's URL; binding.URL
	// is the far side's loopback address and is meaningless on this machine.
	localURL string
	// onDetach ends the connections of the session being dropped. The gateway
	// registers itself here so a caller cannot forget to do it and leave pooled
	// connections pointing at a dead session.
	onDetach func()
	// onReplace and onClose forward the lifecycle to a peer.Listener for the
	// non-browser (ServeTarget) direction, where the mux is read by Accept
	// rather than dialled. Both are nil for a browser endpoint.
	onReplace func(*peer.Mux)
	onClose   func()
}

// NewEndpoint holds the first session of a pair.
func NewEndpoint(mux *peer.Mux, binding Binding) (*Endpoint, error) {
	endpoint := &Endpoint{}
	// The first attachment has no previous session to drop.
	if err := endpoint.replace(mux, binding, false); err != nil {
		return nil, err
	}
	return endpoint, nil
}

// Replace attaches a rebuilt session. The peer's runtime may have restarted in
// the meantime, so a differing runtime generation is adopted rather than
// refused: to the user the page simply recovers, and the generation is still
// what every stream is checked against from here on.
func (endpoint *Endpoint) replace(mux *peer.Mux, binding Binding, dropPrevious bool) error {
	if mux == nil || mux.RuntimeGeneration() != binding.Generation {
		return errors.New("p2p.runtime_generation_mismatch")
	}
	if _, err := binding.Endpoint(); err != nil {
		return err
	}
	endpoint.mu.Lock()
	if endpoint.closed {
		endpoint.mu.Unlock()
		return errors.New("p2p.gateway_closed")
	}
	previous := endpoint.mux
	endpoint.mux, endpoint.binding = mux, binding
	detach, onReplace := endpoint.onDetach, endpoint.onReplace
	endpoint.mu.Unlock()
	if dropPrevious && previous != nil && previous != mux && detach != nil {
		detach()
	}
	if onReplace != nil {
		onReplace(mux)
	}
	return nil
}

// Detach drops expected when it is still the current session without closing
// the gateway. A superseded session may finish after Replace installed a new
// mux; comparing ownership here prevents that stale cleanup from detaching the
// replacement.
func (endpoint *Endpoint) Detach(expected *peer.Mux) bool {
	if expected == nil {
		return false
	}
	endpoint.mu.Lock()
	if endpoint.closed || endpoint.mux != expected {
		endpoint.mu.Unlock()
		return false
	}
	endpoint.mux = nil
	detach, onReplace := endpoint.onDetach, endpoint.onReplace
	endpoint.mu.Unlock()
	if detach != nil {
		detach()
	}
	if onReplace != nil {
		onReplace(nil)
	}
	return true
}

// CurrentMux reports the session this endpoint currently serves, or nil when it
// serves none. Used to detach exactly the session that is ending, so a
// replacement installed in the meantime is never dropped by mistake.
func (endpoint *Endpoint) CurrentMux() *peer.Mux {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return endpoint.mux
}

// Replace attaches a rebuilt session, dropping the previous one's connections
// first so nothing is pooled across two different sessions.
func (endpoint *Endpoint) Replace(mux *peer.Mux, binding Binding) error {
	return endpoint.replace(mux, binding, true)
}

// Close ends the endpoint for good; no later session can be attached.
func (endpoint *Endpoint) Close() {
	endpoint.mu.Lock()
	if endpoint.closed {
		endpoint.mu.Unlock()
		return
	}
	endpoint.closed, endpoint.mux = true, nil
	onClose := endpoint.onClose
	done := endpoint.doneLocked()
	endpoint.mu.Unlock()
	if onClose != nil {
		onClose()
	}
	close(done)
}

// Done reports when the endpoint itself ends — a pair revocation or the
// manager shutting down — as opposed to one session inside it dropping.
func (endpoint *Endpoint) Done() <-chan struct{} {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return endpoint.doneLocked()
}

// doneLocked returns the completion channel, creating it on first use so a
// zero Endpoint behaves like a live one that has not ended. Caller holds mu.
func (endpoint *Endpoint) doneLocked() chan struct{} {
	if endpoint.done == nil {
		endpoint.done = make(chan struct{})
	}
	return endpoint.done
}

// open dials one stream on whatever session is currently attached.
func (endpoint *Endpoint) open() (*peer.Stream, error) {
	endpoint.mu.RLock()
	mux, closed := endpoint.mux, endpoint.closed
	endpoint.mu.RUnlock()
	if closed {
		return nil, errors.New("p2p.gateway_closed")
	}
	if mux == nil {
		// Reconnecting. The tab stays on its address and its next request
		// succeeds; only the ones sent during the gap fail.
		return nil, errors.New("p2p.reconnecting")
	}
	return mux.Open()
}

// target reports the peer runtime URL the proxy forwards to.
func (endpoint *Endpoint) target() (Binding, error) {
	endpoint.mu.RLock()
	defer endpoint.mu.RUnlock()
	if endpoint.closed {
		return Binding{}, errors.New("p2p.gateway_closed")
	}
	return endpoint.binding, nil
}

// Binding reports the runtime binding currently attached, for a caller that
// only needs to read the peer's runtime identity — its generation — without
// dialling through the endpoint.
func (endpoint *Endpoint) Binding() (Binding, error) {
	return endpoint.target()
}

// LocalURL reports the address this machine serves the peer's runtime on. It is
// empty for an endpoint that is not served over a local listener.
func (endpoint *Endpoint) LocalURL() string {
	endpoint.mu.RLock()
	defer endpoint.mu.RUnlock()
	return endpoint.localURL
}

// setLocalURL records the gateway's own address once its listener exists.
func (endpoint *Endpoint) setLocalURL(value string) {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	endpoint.localURL = value
}

// currentMux reports the session attached right now, for a caller that needs
// one to construct something once (a peer.Listener) rather than to dial
// through the endpoint on every call.
func (endpoint *Endpoint) currentMux() (*peer.Mux, error) {
	endpoint.mu.RLock()
	defer endpoint.mu.RUnlock()
	if endpoint.closed {
		return nil, errors.New("p2p.gateway_closed")
	}
	if endpoint.mux == nil {
		return nil, errors.New("p2p.reconnecting")
	}
	return endpoint.mux, nil
}
