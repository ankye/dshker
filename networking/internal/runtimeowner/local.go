// Package runtimeowner owns the long-lived DSH supervisor, separately from the
// replaceable networking core. It never opens an account or platform secret store.
package runtimeowner

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

var (
	ErrOwnerUnavailable      = errors.New("runtime.owner_unavailable")
	ErrOwnerIdentityMismatch = errors.New("runtime.owner_identity_mismatch")
	ErrOwnerRecordInvalid    = errors.New("runtime.owner_record_invalid")
	ErrOwnerProtocol         = errors.New("runtime.owner_protocol_unsupported")
	ErrOwnerConfiguration    = errors.New("runtime.owner_configuration_invalid")
	ErrOwnerShutdown         = errors.New("runtime.owner_shutdown_failed")
	ErrRuntimeUnavailable    = errors.New("p2p.runtime_unavailable")
)

type localBinding struct {
	launchID string
	url      string
	value    runtimebridge.Binding
}

// Local is used only inside the runtime-owner process and explicit unit-test
// compositions. Production cores use Client, never Local as a recovery fallback.
type Local struct {
	mu          sync.Mutex
	supervisor  *harnessruntime.Supervisor
	subjects    map[string]bool
	bindings    map[string]localBinding
	processes   map[string]processIdentity
	trees       []processIdentity
	generation  uint64
	closed      bool
	recovery    *activityJournal
	containment *processContainment
}

func NewLocal() *Local { return NewLocalWithSupervisor(harnessruntime.NewSupervisor()) }

func NewLocalWithSupervisor(supervisor *harnessruntime.Supervisor) *Local {
	return &Local{supervisor: supervisor, subjects: make(map[string]bool), bindings: make(map[string]localBinding), processes: make(map[string]processIdentity)}
}

func operationContext(ctx context.Context) error {
	if ctx.Err() != nil {
		return errors.New("p2p.request_cancelled")
	}
	return nil
}

func (local *Local) Start(ctx context.Context, request harnessruntime.LaunchRequest) (harnessruntime.LaunchView, error) {
	local.mu.Lock()
	defer local.mu.Unlock()
	if err := local.admit(ctx); err != nil {
		return harnessruntime.LaunchView{}, err
	}
	if err := harnessruntime.AssertLaunchRequest(request); err != nil {
		return harnessruntime.LaunchView{}, err
	}
	if current, present := local.supervisor.Status(request.SubjectID); present && (current.State == harnessruntime.StateRunning || current.State == harnessruntime.StateStarting) {
		return harnessruntime.LaunchView{}, harnessruntime.ErrOperationInProgress
	}
	if request.Port.Mode == "fixed" {
		// Port preparation is a read-only admission check. A residual command name
		// is not authority to kill anything, including this owner's current child.
		if err := checkFreePort(request.Port.Port); err != nil {
			return harnessruntime.LaunchView{}, err
		}
	}
	command, err := harnessruntime.BuildCommand(request)
	if err != nil {
		return harnessruntime.LaunchView{}, err
	}
	var checkpoint activityCheckpoint
	if local.recovery != nil {
		checkpoint, err = local.recovery.beforeStart(request.SubjectID)
		if err != nil {
			return harnessruntime.LaunchView{}, err
		}
	}
	view, err := local.supervisor.StartCommand(command, harnessruntime.Identity{
		LaunchID: request.LaunchID, SubjectID: request.SubjectID, Port: request.Port, LogPath: request.LogPath,
	})
	if err != nil && local.recovery != nil {
		if rollbackErr := local.recovery.abortStart(request.SubjectID, checkpoint); rollbackErr != nil {
			return harnessruntime.LaunchView{}, rollbackErr
		}
	}
	if err == nil {
		local.subjects[request.SubjectID] = true
		delete(local.bindings, request.SubjectID)
		treeIndex := len(local.trees)
		local.trees = append(local.trees, processIdentity{PID: view.PID})
		identity, identityErr := processIdentityAt(view.PID)
		if identityErr != nil {
			_, _ = local.supervisor.Stop(request.SubjectID)
			return harnessruntime.LaunchView{}, harnessruntime.ErrChildUnavailable
		}
		local.processes[request.SubjectID] = identity
		local.trees[treeIndex] = identity
		if local.recovery != nil {
			if err := local.recovery.afterStart(); err != nil {
				_, _ = local.supervisor.Stop(request.SubjectID)
				return harnessruntime.LaunchView{}, err
			}
		}
	}
	return view, err
}

func checkFreePort(port int) error {
	// Check the two exact loopback families served by a DSH binding. A wildcard
	// probe may coexist with a specific-address listener on Darwin and is not
	// proof that the actual loopback address is free.
	ipv4, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return harnessruntime.ErrPortInUse
	}
	defer ipv4.Close()
	ipv6, err := net.Listen("tcp6", net.JoinHostPort("::1", strconv.Itoa(port)))
	if err != nil {
		return harnessruntime.ErrPortInUse
	}
	if ipv6.Close() != nil {
		return harnessruntime.ErrChildUnavailable
	}
	return nil
}

func (local *Local) Stop(ctx context.Context, subject string) (harnessruntime.LaunchView, error) {
	local.mu.Lock()
	defer local.mu.Unlock()
	if err := local.admit(ctx); err != nil {
		return harnessruntime.LaunchView{}, err
	}
	delete(local.bindings, subject)
	return local.stopRuntime(subject)
}

// A nil Stop, or a stopped root, is not proof its descendants were joined.
// Kernel containment/process-group evidence owns the durable idle assertion.
func (local *Local) stopRuntime(subject string) (harnessruntime.LaunchView, error) {
	view, err := local.supervisor.Stop(subject)
	if err != nil || local.recovery == nil {
		return view, err
	}
	return view, local.confirmQuiescent()
}

func (local *Local) confirmQuiescent() error {
	if local.recovery == nil {
		return nil
	}
	if local.containment == nil {
		return ErrOwnerUnavailable
	}
	// Kernel termination and reaping can lag the root process acknowledgement.
	// This is a bounded proof probe, never a relaxed child-stop budget.
	deadline := time.Now().Add(time.Second)
	for {
		gone, err := local.containment.allChildrenGone(local.trees)
		if err != nil {
			return err
		}
		if gone {
			if err := local.recovery.confirmIdle(); err != nil {
				return err
			}
			local.trees = nil
			return nil
		}
		if time.Now().After(deadline) {
			return nil
		} // Retain the non-idle fence.
		time.Sleep(10 * time.Millisecond)
	}
}

func (local *Local) Status(ctx context.Context, subject string) (harnessruntime.LaunchView, bool, error) {
	local.mu.Lock()
	defer local.mu.Unlock()
	if err := local.admit(ctx); err != nil {
		return harnessruntime.LaunchView{}, false, err
	}
	view, present := local.supervisor.Status(subject)
	return view, present, nil
}

func (local *Local) Console(ctx context.Context, cursor int64) ([]harnessruntime.ConsoleEntry, int64, error) {
	local.mu.Lock()
	defer local.mu.Unlock()
	if err := local.admit(ctx); err != nil {
		return nil, 0, err
	}
	entries, next := local.supervisor.Console().After(cursor)
	return entries, next, nil
}

func (local *Local) Binding(ctx context.Context, subject string) (runtimebridge.Binding, error) {
	local.mu.Lock()
	defer local.mu.Unlock()
	if err := local.admit(ctx); err != nil {
		return runtimebridge.Binding{}, err
	}
	view, present := local.supervisor.Status(subject)
	if !present || view.State != harnessruntime.StateRunning || view.URL == "" || view.PID <= 0 || !harnessruntime.ProcessAlive(view.PID) {
		delete(local.bindings, subject)
		return runtimebridge.Binding{}, ErrRuntimeUnavailable
	}
	identity, err := processIdentityAt(view.PID)
	if err != nil || identity != local.processes[subject] {
		delete(local.bindings, subject)
		return runtimebridge.Binding{}, ErrRuntimeUnavailable
	}
	current, present := local.bindings[subject]
	if !present || current.launchID != view.LaunchID || current.url != view.URL {
		local.generation++
		current = localBinding{view.LaunchID, view.URL, runtimebridge.Binding{Generation: local.generation, URL: view.URL}}
		local.bindings[subject] = current
	}
	return current.value, nil
}

func (local *Local) admit(ctx context.Context) error {
	if err := operationContext(ctx); err != nil {
		return err
	}
	if local.closed || local.supervisor == nil {
		return ErrOwnerUnavailable
	}
	return nil
}

// Shutdown admits no new start while it joins the real children. A failed stop
// retains the owner so the caller can observe/retry rather than losing authority.
func (local *Local) Shutdown(ctx context.Context) error {
	local.mu.Lock()
	defer local.mu.Unlock()
	if err := operationContext(ctx); err != nil {
		return err
	}
	if local.closed {
		return nil
	}
	var stopFailure error
	for subject := range local.subjects {
		delete(local.bindings, subject)
		if _, err := local.stopRuntime(subject); err != nil {
			stopFailure = err
		}
	}
	if local.containment != nil {
		if err := local.containment.stopAllChildren(ctx); err != nil {
			return err
		}
	}
	if err := local.confirmQuiescent(); err != nil {
		return err
	}
	if local.recovery != nil && !local.recovery.clean() {
		return ErrOwnerShutdown // Preserve ownership evidence for an unjoined tree.
	}
	if local.recovery == nil && stopFailure != nil {
		return stopFailure
	}
	local.closed = true
	return nil
}

var _ harnessruntime.Authority = (*Local)(nil)
