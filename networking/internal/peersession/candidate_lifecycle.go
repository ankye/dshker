package peersession

import (
	"context"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func (manager *Manager) acceptCandidate(ticket protocol.CandidateTicket) {
	manager.mu.Lock()
	owner := manager.signals
	manager.mu.Unlock()
	if owner == nil {
		return
	}
	active, ok := owner.current()
	if !ok {
		return
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return
	}
	fence, err := control.Registration()
	if err == nil {
		manager.acceptCandidateFrom(ticket, &targetPromotionAdmission{owner: owner, active: active, fence: fence})
	}
}

func (manager *Manager) reserveInboundCandidate(ticket protocol.CandidateTicket) (*session, error) {
	manager.mu.Lock()
	owner := manager.signals
	manager.mu.Unlock()
	if owner == nil {
		return nil, errors.New("p2p.registration_stale")
	}
	active, ok := owner.current()
	if !ok {
		return nil, errors.New("p2p.registration_stale")
	}
	control, ok := active.(controlSubscription)
	if !ok {
		return nil, errors.New("p2p.protocol_mismatch")
	}
	fence, err := control.Registration()
	if err != nil {
		return nil, err
	}
	if err := ticket.Verify(manager.config.Authority.PublicKey); err != nil {
		return nil, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	unlock, err := manager.lockInboundScopeLocked(ticket, &targetPromotionAdmission{owner: owner, active: active, fence: fence})
	if err != nil {
		return nil, err
	}
	defer unlock()
	connection, previous, duplicate, err := manager.reserveInboundCandidateLocked(ticket)
	if previous != nil || duplicate {
		return nil, errors.New("p2p.connection_busy")
	}
	return connection, err
}

func (manager *Manager) runCandidate(connection *session, initiator bool) {
	state := State{PairID: connection.PairID, AttemptID: connection.lease.AttemptID, Generation: connection.lease.Generation, Stage: "punching"}
	manager.candidateProgress(connection, state)
	renewed, observed, diagnostics := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() { defer close(renewed); manager.renew(connection) }()
	go func() { defer close(observed); manager.observeCandidateTransport(connection) }()
	go func() { defer close(diagnostics); manager.observeSession(connection) }()
	observer := manager.startCandidateDecisionObserver(connection)
	defer func() {
		observer.stop()
		terminal := manager.sessionDiagnostic(connection, "terminated", connection.transport.Diagnostics())
		connection.cancel()
		connection.transport.Close()
		if connection.signalDone != nil {
			<-connection.signalDone
		}
		<-renewed
		<-observed
		<-diagnostics
		writeSessionDiagnostic(terminal)
		manager.cleanupCandidate(connection, state)
	}()
	if connection.cancellationRequested() {
		manager.resolveCandidateCancellationAfterObserver(connection, observer.stop())
		return
	}
	ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	err := connection.transport.WaitReady(ctx)
	cancel()
	if err == nil {
		state.Path, err = connection.transport.Path()
	}
	if err == nil {
		state.Stage = "starting-runtime"
		manager.candidateProgress(connection, state)
		install := func(mux *peer.Mux, binding runtimebridge.Binding) (*runtimebridge.Gateway, *runtimebridge.Endpoint, error) {
			return manager.stageCandidate(connection, mux, binding, initiator)
		}
		owners := runtimebridge.WorkbenchOwners{Open: manager.runtimeOwner(connection), Resume: manager.runtimeResumeOwner(connection)}
		_, _, _, _, _, err = runtimebridge.Establish(connection.ctx, connection.transport, connection.lease, initiator, connection.requestWorkbench, connection.resumeWorkbench, owners, install)
	}
	if err == nil && initiator {
		err = manager.probeCandidate(connection)
	}
	// Only the early observer is cancelled. Its join publishes any dispatched
	// unknown Cancel before the same-ticket main resolver takes control.
	unknownCancel := observer.stop()
	if err != nil {
		connection.noteStop("candidate_establishment_failed", err)
		state.Stage, state.Error = "failed", namedRefusal(err, state.Stage == "starting-runtime")
		connection.complete(Connected{State: state}, errors.New(state.Error))
		manager.candidateProgress(connection, state)
		manager.resolveCandidateCancellationAfterObserver(connection, unknownCancel)
		return
	}
	if connection.cancellationRequested() || unknownCancel {
		err = manager.resolveCandidateCancellationAfterObserver(connection, unknownCancel)
	} else {
		err = manager.readyAndResolveCandidate(connection, initiator)
	}
	if err != nil {
		connection.noteStop("candidate_decision_failed", err)
		state.Stage, state.Error = "failed", namedRefusal(err, true)
		connection.complete(Connected{State: state}, errors.New(state.Error))
		manager.candidateProgress(connection, state)
		return
	}
	select {
	case <-connection.ctx.Done():
		connection.noteStop("session_context_done", connection.ctx.Err())
	case <-connection.transport.Done():
		connection.noteStop("transport_done", errors.New("p2p.direct_closed"))
	case <-connection.mux.Done():
		connection.noteStop("mux_done", connection.mux.Err())
	}
}

func (manager *Manager) stageCandidate(connection *session, mux *peer.Mux, binding runtimebridge.Binding, initiator bool) (*runtimebridge.Gateway, *runtimebridge.Endpoint, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if !manager.ownsCandidateLocked(connection, initiator) || connection.ctx.Err() != nil {
		return nil, nil, errors.New("p2p.stale_generation")
	}
	if _, pinned := manager.pins[connection.PairID]; !pinned {
		return nil, nil, errors.New("p2p.pair_unauthorized")
	}
	gateway, endpoint, err := runtimebridge.Attach(manager.ctx, mux, binding, initiator, nil)
	if err != nil {
		return nil, nil, err
	}
	connection.mu.Lock()
	connection.mux, connection.stagedGateway, connection.stagedEndpoint = mux, gateway, endpoint
	connection.result.State.RuntimeGeneration = binding.Generation
	connection.mu.Unlock()
	return gateway, endpoint, nil
}

func (manager *Manager) probeCandidate(connection *session) error {
	connection.mu.Lock()
	gateway, endpoint := connection.stagedGateway, connection.stagedEndpoint
	connection.mu.Unlock()
	if !connection.requestWorkbench {
		return nil
	}
	if gateway == nil || endpoint == nil {
		return errors.New("p2p.runtime_unavailable")
	}
	// This URL belongs solely to the candidate mux. The stable browser endpoint
	// still serves the old primary; probing it would validate the wrong path.
	return runtimebridge.Probe(connection.ctx, gateway.URL)
}

func (manager *Manager) candidateProgress(connection *session, state State) {
	manager.mu.Lock()
	visible := connection.lease.FromDeviceID == manager.config.Device.DeviceID && manager.sessions[connection.PairID] == nil && manager.candidates[connection.PairID] == connection
	manager.mu.Unlock()
	connection.mu.Lock()
	state.RuntimeGeneration = connection.result.State.RuntimeGeneration
	connection.result.State = state
	connection.mu.Unlock()
	if visible {
		manager.emitCurrent(state)
	}
}

func (manager *Manager) ownsCandidateLocked(connection *session, initiator bool) bool {
	if manager.closed {
		return false
	}
	if initiator {
		return manager.candidates[connection.PairID] == connection
	}
	return manager.inboundCandidates[connection.PairID] == connection
}

func (manager *Manager) cleanupCandidate(connection *session, state State) {
	connection.mu.Lock()
	mux, endpoint, staged := connection.mux, connection.endpoint, connection.stagedEndpoint
	connection.mu.Unlock()
	if endpoint != nil && mux != nil {
		endpoint.Detach(mux)
	}
	if staged != nil && staged != endpoint {
		staged.Close()
	}
	if mux != nil {
		mux.Close()
	}
	manager.mu.Lock()
	promoted := connection.promoted
	manager.mu.Unlock()
	if promoted {
		state = connectionState(connection)
		state.Stage, state.Error = "disconnected", ""
		manager.mu.Lock()
		connection.mu.Lock()
		connection.result.State = state
		connection.mu.Unlock()
		manager.mu.Unlock()
		manager.emitOwned(connection, state)
	}
	manager.endCandidate(connection, "failed")
	connection.complete(Connected{State: state}, errors.New("p2p.connection_cancelled"))
	manager.finish(connection.PairID, connection)
	manager.wake(connection.PairID)
}

func connectionState(connection *session) State {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return connection.result.State
}

func (manager *Manager) emitOwned(connection *session, state State) {
	manager.mu.Lock()
	owned := manager.sessions[connection.PairID] == connection && !manager.closed
	manager.mu.Unlock()
	if owned {
		manager.emitCurrent(state)
	}
}

func (manager *Manager) emitCurrent(state State) {
	manager.emitMu.Lock()
	defer manager.emitMu.Unlock()
	if manager.OwnsState(state) {
		manager.emit(state)
	}
}

func (manager *Manager) isPromoted(connection *session) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return connection.promoted
}

func (manager *Manager) wake(pairID string) {
	if manager.config.Wake != nil {
		manager.config.Wake(pairID)
	}
}

func (manager *Manager) observeCandidateTransport(connection *session) {
	for {
		select {
		case <-connection.ctx.Done():
			return
		case <-connection.transport.Changes():
			manager.transportChanged(connection)
		}
	}
}

func (manager *Manager) transportChanged(connection *session) {
	manager.mu.Lock()
	live := connection.transport.LiveState()
	initiator := connection.lease.FromDeviceID == manager.config.Device.DeviceID
	primary := manager.sessions[connection.PairID]
	candidate := manager.candidates[connection.PairID]
	if !initiator {
		primary, candidate = manager.inbound[connection.PairID], manager.inboundCandidates[connection.PairID]
	}
	owned := primary == connection && connection.promoted && !manager.closed
	recovered := live.Ready && !connection.remoteReplaced
	if !owned {
		manager.mu.Unlock()
		return
	}
	state := connectionState(connection)
	if recovered {
		if state.Stage != "suspended" {
			manager.mu.Unlock()
			return
		}
		if state.RuntimeGeneration > 0 {
			state.Stage = "ready"
		} else {
			state.Stage = "connected"
		}
		if candidate != nil && candidate.predecessorWasSuspended && (!candidate.requestWorkbench || state.RuntimeGeneration > 0) {
			candidate.requestCancel()
		}
	} else {
		if !live.Suspended || state.Stage == "suspended" {
			manager.mu.Unlock()
			return
		}
		state.Stage = "suspended"
	}
	state.Error = ""
	connection.mu.Lock()
	connection.result.State = state
	connection.mu.Unlock()
	manager.mu.Unlock()
	if initiator {
		manager.emitOwned(connection, state)
		manager.wake(connection.PairID)
	}
}
