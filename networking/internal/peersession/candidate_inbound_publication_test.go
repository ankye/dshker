package peersession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Local TLS and actual unnegotiated Pion resources; subscription event lifetime
// is controlled through the existing test adapter, not a real coordinator WSS.
type inboundPublicationBoundary struct {
	*inboundAdmissionBoundary
	endEntered, endRelease chan struct{}
	endOnce, endUnblock    sync.Once
}

func newInboundPublicationBoundary(t *testing.T) *inboundPublicationBoundary {
	t.Helper()
	f := &inboundAdmissionBoundary{t: t, response: "pending", firstRead: make(chan struct{}),
		firstRelease: make(chan struct{}), read: make(chan struct{}), release: make(chan struct{})}
	w := &inboundPublicationBoundary{inboundAdmissionBoundary: f, endEntered: make(chan struct{}), endRelease: make(chan struct{})}
	manager, fence, key := controlCandidateManager(t, http.HandlerFunc(w.serve))
	f.manager, f.active = manager, manager.signals.active.(*candidateSubscription)
	_, pin := pinFixture()
	delete(manager.pins, pin.Pair.PairID)
	// Production scoped publication keys pins by the remote device, not the
	// legacy unit helper's arbitrary pairs-table ID. Normalize before any runner.
	pin.Pair.PairID = pin.Target.DeviceID
	manager.pins[pin.Pair.PairID] = pin
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(),
		UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID,
		Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	remoteCore := protocol.NewNonce()
	f.old = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	request.AttemptID, request.Generation = protocol.NewNonce(), 2
	f.next = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	f.terminal = inboundAdmissionTerminal(f.old)
	var err error
	f.oldOwner, err = manager.reserveInboundCandidate(f.old)
	if err != nil {
		t.Fatal(err)
	}
	candidateTransportKey(t, manager, f.oldOwner)
	if err := manager.createCandidateTransport(f.oldOwner); err != nil {
		t.Fatal(err)
	}
	go manager.runCandidate(f.oldOwner, false)
	t.Cleanup(func() {
		w.releaseEnd()
		f.unblock()
		f.firstReleaseOnce.Do(func() { close(f.firstRelease) })
		manager.Close()
	})
	if !inboundRetirementAwait(t, f.firstRead, "actual old runner's held State") {
		t.FailNow()
	}
	return w
}

func (w *inboundPublicationBoundary) releaseEnd() { w.endUnblock.Do(func() { close(w.endRelease) }) }

func (w *inboundPublicationBoundary) serve(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v2/end" {
		w.inboundAdmissionBoundary.serve(response, request)
		return
	}
	var end protocol.EndCandidate
	if json.NewDecoder(request.Body).Decode(&end) != nil || end.Ticket != w.next || end.Reason != "failed" {
		w.t.Error("publication cleanup changed its exact queued End")
		response.WriteHeader(http.StatusBadRequest)
		return
	}
	w.endOnce.Do(func() { close(w.endEntered) })
	select {
	case <-request.Context().Done():
		return
	case <-w.endRelease:
	}
	json.NewEncoder(response).Encode(protocol.EndResult{AttemptID: w.next.Lease.AttemptID, Generation: w.next.Lease.Generation, Ended: true, Reason: end.Reason})
}

func (w *inboundPublicationBoundary) queuePublication(t *testing.T, active subscription) *inboundAdmission {
	t.Helper()
	w.manager.receiveControl(active, controlplane.SignalEvent{Type: "candidate", Ticket: w.next})
	w.manager.mu.Lock()
	job := w.manager.inboundAdmissions[w.oldOwner.PairID]
	w.manager.mu.Unlock()
	if job == nil || !inboundRetirementAwait(t, w.read, "independent queued State remained in flight") {
		t.Fatal("missing exact publication read owner")
	}
	return job
}

func inboundPublicationPins(t *testing.T, manager *Manager, pair string) ([]byte, controlplane.PairIdentity) {
	t.Helper()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	data, err := json.Marshal(manager.pins)
	if err != nil {
		t.Fatal(err)
	}
	return data, manager.pins[pair]
}

func TestInboundAdmissionFailedPinPublicationPreservesQueuedOwner(t *testing.T) {
	for _, kind := range []string{"commit-error", "late-invalid-identity"} {
		t.Run(kind, func(t *testing.T) {
			w := newInboundPublicationBoundary(t)
			job := w.queuePublication(t, w.active)
			before, revised := inboundPublicationPins(t, w.manager, w.oldOwner.PairID)
			revised.Pair.Revision++
			identities := []controlplane.PairIdentity{revised}
			if kind == "late-invalid-identity" {
				invalid := revised
				invalid.Pair.NetworkID = ""
				identities = append(identities, invalid)
			}
			commitCalls := 0
			commitFailure := errors.New("test.pin-publication-failed")
			err := w.manager.CommitScopedPins(w.active.fence, w.old.Lease.UserID, identities, func() error {
				commitCalls++
				return commitFailure
			})
			if err == nil || kind == "commit-error" && (err != commitFailure || commitCalls != 1) || kind == "late-invalid-identity" && commitCalls != 0 {
				t.Error("failed scoped transaction did not stop at its actual failure", err)
			}
			after, _ := inboundPublicationPins(t, w.manager, w.oldOwner.PairID)
			w.manager.mu.Lock()
			retained := w.manager.inboundAdmissions[w.oldOwner.PairID] == job && w.manager.inboundCandidates[w.oldOwner.PairID] == w.oldOwner
			w.manager.mu.Unlock()
			if !bytes.Equal(before, after) || !retained || job.connection.ctx.Err() != nil {
				t.Error("rolled-back pin publication irreversibly cancelled or replaced its captured admission")
			}
			select {
			case <-job.done:
				t.Error("failed publication completed/cancelled the held admission read")
			default:
			}
			w.unblock()
			if inboundRetirementAwait(t, job.done, "unchanged owner resolved its original pending State") && (job.err == nil || job.err.Error() != "p2p.connection_busy") {
				t.Error("rollback changed the original State outcome", job.err)
			}
		})
	}
}

func TestInboundAdmissionSuccessfulPinPublicationCancelsQueuedOwner(t *testing.T) {
	w := newInboundPublicationBoundary(t)
	job := w.queuePublication(t, w.active)
	_, revised := inboundPublicationPins(t, w.manager, w.oldOwner.PairID)
	revised.Pair.Revision++
	committed := false
	if err := w.manager.CommitScopedPins(w.active.fence, w.old.Lease.UserID, []controlplane.PairIdentity{revised}, func() error { committed = true; return nil }); err != nil {
		t.Fatal(err)
	}
	_, published := inboundPublicationPins(t, w.manager, w.oldOwner.PairID)
	if !committed || published.Pair != revised.Pair || job.connection.ctx.Err() == nil {
		t.Error("successful pin publication did not revoke the exact changed captured owner")
	}
	inboundRetirementAwait(t, job.done, "successful publication cancelled and joined the held read")
}

// Events may close before subscription Done is published. Keep that exact
// ordering observable instead of relying on goroutine scheduling or a sleep.
type inboundPublicationSubscription struct {
	*candidateSubscription
	events chan controlplane.SignalEvent
	once   sync.Once
}

func (s *inboundPublicationSubscription) Events() <-chan controlplane.SignalEvent { return s.events }
func (s *inboundPublicationSubscription) Close()                                  { s.once.Do(func() { close(s.events) }) }

func TestInboundAdmissionReceiveExitJoinsOnlyItsReadPhase(t *testing.T) {
	for _, mode := range []string{"events-ended", "close-and-wait"} {
		t.Run(mode, func(t *testing.T) {
			w := newInboundPublicationBoundary(t)
			owner := w.manager.signals
			active := &inboundPublicationSubscription{candidateSubscription: w.active, events: make(chan controlplane.SignalEvent)}
			ctx, cancel := context.WithCancel(w.manager.ctx)
			owner.mu.Lock()
			owner.ctx, owner.cancel, owner.active = ctx, cancel, active
			owner.mu.Unlock()
			received := make(chan struct{})
			returned := received
			owner.startWorker(func() { w.manager.receive(active); close(received) })
			job := w.queuePublication(t, active)
			wake, releaseWake, woke := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			w.manager.config.Wake = func(string) {
				if calls.Add(1) == 1 {
					close(wake)
					<-releaseWake
					close(woke)
				}
			}
			var wakeOnce sync.Once
			unblockWake := func() { wakeOnce.Do(func() { close(releaseWake) }) }
			defer unblockWake()
			if mode == "close-and-wait" {
				next := candidateSubscriptionFor(w.manager.config.CoreInstanceID)
				next.fence.ServerEpoch = w.active.fence.ServerEpoch
				nextCtx, nextCancel := context.WithCancel(w.manager.ctx)
				w.manager.mu.Lock()
				w.manager.signals = &signaling{ctx: nextCtx, cancel: nextCancel, active: next}
				w.manager.mu.Unlock()
				joined := make(chan struct{})
				go func() { owner.closeAndWait(); close(joined) }()
				returned = joined
			} else {
				active.Close()
			}
			if !inboundRetirementAwait(t, returned, "receive/closeAndWait joined read phase without waiting for End") {
				return
			}
			select {
			case <-job.done:
			default:
				t.Error("receive lifetime ended before its same-subscription admission read owner joined")
				return
			}
			if !inboundRetirementAwait(t, w.endEntered, "deferred exact queued cleanup End") {
				return
			}
			select {
			case <-job.connection.done:
				t.Error("read-phase join falsely completed the still-blocked End cleanup")
			default:
			}
			w.releaseEnd()
			if !inboundRetirementAwait(t, wake, "cleanup reached external Wake after read-phase join") {
				return
			}
			inboundRetirementAwait(t, job.connection.done, "actual End/connection cleanup completed")
			unblockWake()
			inboundRetirementAwait(t, woke, "test-owned external callback joined")
		})
	}
}
