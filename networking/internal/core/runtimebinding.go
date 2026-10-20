package core

import (
	"context"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// ErrRuntimeUnavailable is the refusal a host with no running child answers: the
// same code the desktop runtime owner reports when its child is stopped or
// failed, so a peer cannot tell which half of the product it is talking to.
var ErrRuntimeUnavailable = errors.New("p2p.runtime_unavailable")

// RuntimeBindingAuthority owns the runtime generation as well as its address.
// The core only forwards this read; it cannot invent a new generation at restart.
type RuntimeBindingAuthority interface {
	Binding(context.Context, string) (runtimebridge.Binding, error)
}

// RuntimeBinding is the core's facade over its runtime owner: it answers what a peer
// asks before it can open this machine's workbench — which loopback address is
// this host serving, and which generation of it.
//
// The desktop shell answers the same question from its own runtime owner. A
// headless core delegates to the independent authority which survives its
// restart. No address or generation is cached in this replaceable facade.
type RuntimeBinding struct {
	// Runtime is the process authority that holds the headless child.
	Runtime RuntimeBindingAuthority
	// Subject is the launch subject the child was started under.
	Subject string
}

// Binding returns the address a peer may reach, refusing with
// p2p.runtime_unavailable when this host has no running child.
//
// A child that is not running, has not announced a URL, or was replaced by a
// different launch is a different generation: the generation is what tells a
// peer that an address it already holds is gone, so it never reuses a proxy
// target that belongs to a child that no longer exists.
func (binding *RuntimeBinding) Binding() (runtimebridge.Binding, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return binding.BindingContext(ctx)
}

// BindingContext retains the RPC caller's cancellation and the authority's exact
// error, including an unreachable owner rather than reporting an empty runtime.
func (binding *RuntimeBinding) BindingContext(ctx context.Context) (runtimebridge.Binding, error) {
	if binding == nil || binding.Runtime == nil {
		return runtimebridge.Binding{}, ErrRuntimeUnavailable
	}
	return binding.Runtime.Binding(ctx, binding.Subject)
}
