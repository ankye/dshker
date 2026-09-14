package core

import (
	"errors"
	"sync"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// ErrRuntimeUnavailable is the refusal a host with no running child answers: the
// same code the desktop runtime owner reports when its child is stopped or
// failed, so a peer cannot tell which half of the product it is talking to.
var ErrRuntimeUnavailable = errors.New("p2p.runtime_unavailable")

// RuntimeStatus is the one question the binding asks the child authority, which
// the supervisor answers and a test can stand in for.
type RuntimeStatus interface {
	Status(subjectID string) (harnessruntime.LaunchView, bool)
}

// RuntimeBinding is the core's runtime owner: it answers the one question a peer
// asks before it can open this machine's workbench — which loopback address is
// this host serving, and which generation of it.
//
// The desktop shell answers the same question from its own runtime owner. A
// headless core cannot: it has no renderer to keep that state, so the answer
// comes from the child it supervises. The binding is recomputed on every ask
// rather than cached, because the child may be replaced between two questions,
// and a binding that names a dead address is worse than no binding at all.
type RuntimeBinding struct {
	// Runtime is the process authority that holds the headless child.
	Runtime RuntimeStatus
	// Subject is the launch subject the child was started under.
	Subject string

	mutex      sync.Mutex
	generation uint64
	launchID   string
	url        string
}

// Binding returns the address a peer may reach, refusing with
// p2p.runtime_unavailable when this host has no running child.
//
// A child that is not running, has not announced a URL, or was replaced by a
// different launch is a different generation: the generation is what tells a
// peer that an address it already holds is gone, so it never reuses a proxy
// target that belongs to a child that no longer exists.
func (binding *RuntimeBinding) Binding() (runtimebridge.Binding, error) {
	if binding == nil || binding.Runtime == nil {
		return runtimebridge.Binding{}, ErrRuntimeUnavailable
	}
	view, present := binding.Runtime.Status(binding.Subject)
	if !present || view.State != harnessruntime.StateRunning || view.URL == "" {
		return runtimebridge.Binding{}, ErrRuntimeUnavailable
	}
	binding.mutex.Lock()
	defer binding.mutex.Unlock()
	if binding.launchID != view.LaunchID || binding.url != view.URL {
		binding.generation++
		binding.launchID = view.LaunchID
		binding.url = view.URL
	}
	return runtimebridge.Binding{Generation: binding.generation, URL: binding.url}, nil
}
