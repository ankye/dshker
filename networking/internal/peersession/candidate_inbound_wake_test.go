package peersession

import (
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Real TLS control cleanup and an actual, unnegotiated Pion transport. The test
// subscription is an adapter, not a full coordinator-WSS or physical run.
type inboundWakeBoundary struct {
	manager                   *Manager
	active                    *candidateSubscription
	old, next                 protocol.CandidateTicket
	oldOwner                  *session
	firstRead, firstRelease   chan struct{}
	read, readRelease         chan struct{}
	end, endRelease, endReply chan struct{}
	wake, wakeRelease, woke   chan struct{}
	firstOnce, readOnce       sync.Once
	readUnblock, endUnblock   sync.Once
	wakeUnblock, firstUnblock sync.Once
	stateCalls, wakeCalls     atomic.Int32
}

func newInboundWakeBoundary(t *testing.T) *inboundWakeBoundary {
	t.Helper()
	f := &inboundWakeBoundary{firstRead: make(chan struct{}), firstRelease: make(chan struct{}),
		read: make(chan struct{}), readRelease: make(chan struct{}), end: make(chan struct{}),
		endRelease: make(chan struct{}), endReply: make(chan struct{}), wake: make(chan struct{}),
		wakeRelease: make(chan struct{}), woke: make(chan struct{})}
	manager, fence, key := controlCandidateManager(t, http.HandlerFunc(f.serve))
	f.manager, f.active = manager, manager.signals.active.(*candidateSubscription)
	_, pin := pinFixture()
	request := protocol.PrepareCandidate{Registration: fence, AttemptID: protocol.NewNonce(),
		UserID: pin.Initiator.UserID, NetworkID: pin.Pair.NetworkID, PairID: manager.config.Device.DeviceID,
		Generation: 1, ToCoreInstanceID: manager.config.CoreInstanceID}
	remoteCore := protocol.NewNonce()
	f.old = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	request.AttemptID, request.Generation = protocol.NewNonce(), 2
	f.next = signedCandidate(request, pin.Target.DeviceID, remoteCore, key)
	var err error
	f.oldOwner, err = manager.reserveInboundCandidate(f.old)
	if err != nil {
		t.Fatal(err)
	}
	candidateTransportKey(t, manager, f.oldOwner)
	manager.config.Wake = func(pair string) {
		if f.wakeCalls.Add(1) == 1 {
			close(f.wake)
			<-f.wakeRelease // Models the external Host/account callback owner.
			close(f.woke)
		}
	}
	if err := manager.createCandidateTransport(f.oldOwner); err != nil {
		t.Fatal(err)
	}
	go manager.runCandidate(f.oldOwner, false)
	t.Cleanup(func() {
		f.releaseWake()
		f.releaseEnd()
		f.releaseRead()
		f.firstUnblock.Do(func() { close(f.firstRelease) })
		manager.Close()
		inboundRetirementAwait(t, f.woke, "test-owned Wake callback joined")
	})
	if !inboundRetirementAwait(t, f.firstRead, "actual old runner's held State read") {
		t.FailNow()
	}
	return f
}

func (f *inboundWakeBoundary) releaseWake() { f.wakeUnblock.Do(func() { close(f.wakeRelease) }) }
func (f *inboundWakeBoundary) releaseEnd()  { f.endUnblock.Do(func() { close(f.endRelease) }) }
func (f *inboundWakeBoundary) releaseRead() { f.readUnblock.Do(func() { close(f.readRelease) }) }

func (f *inboundWakeBoundary) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1/turn-credentials":
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.relay_unconfigured"})
	case "/v2/candidates/state":
		var request protocol.CandidateStateRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.AttemptID != f.old.Lease.AttemptID {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if f.stateCalls.Add(1) == 1 {
			f.firstOnce.Do(func() { close(f.firstRead) })
			select {
			case <-r.Context().Done():
			case <-f.firstRelease:
			}
			return
		}
		f.readOnce.Do(func() { close(f.read) })
		select {
		case <-r.Context().Done():
			return
		case <-f.readRelease:
		}
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"code": "p2p.rate_limited"})
	case "/v2/end":
		var request protocol.EndCandidate
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Ticket != f.next || request.Reason != "failed" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		close(f.end)
		select {
		case <-r.Context().Done():
			return
		case <-f.endRelease:
		}
		json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: f.next.Lease.AttemptID, Generation: f.next.Lease.Generation, Ended: true, Reason: request.Reason})
		close(f.endReply)
	default:
		http.NotFound(w, r)
	}
}

func TestInboundAdmissionCloseDoesNotJoinExternalWakeAfterCleanup(t *testing.T) {
	for _, scopeCancel := range []bool{false, true} {
		name := "unknown-state-refusal"
		if scopeCancel {
			name = "subscription-scope-cancel"
		}
		t.Run(name, func(t *testing.T) {
			f := newInboundWakeBoundary(t)
			defer f.releaseWake()
			f.manager.receiveControl(f.active, controlplane.SignalEvent{Type: "candidate", Ticket: f.next})
			f.manager.mu.Lock()
			job := f.manager.inboundAdmissions[f.oldOwner.PairID]
			f.manager.mu.Unlock()
			if job == nil || !inboundRetirementAwait(t, f.read, "queued admission's blocked State") {
				t.Fatal("missing actual admission read owner")
			}
			if scopeCancel {
				next := candidateSubscriptionFor(f.manager.config.CoreInstanceID)
				next.fence.ServerEpoch = f.active.fence.ServerEpoch
				f.manager.signals.mu.Lock()
				f.manager.signals.active = next
				f.manager.signals.mu.Unlock()
				f.active.Close()
			} else {
				f.releaseRead()
			}
			if !inboundRetirementAwait(t, f.end, "failed queued owner's exact End request") {
				return
			}
			select {
			case <-job.connection.done:
				t.Error("connection.done was published before its actual End reply")
			default:
			}
			select {
			case <-f.wake:
				t.Error("Wake preceded the blocked cleanup End")
			default:
			}
			f.releaseEnd()
			if !inboundRetirementAwait(t, f.wake, "failed cleanup reached external Wake") {
				return
			}
			if !inboundRetirementAwait(t, f.endReply, "real TLS End reply completed") || !inboundRetirementAwait(t, job.connection.done, "queued connection cleanup completed before Wake") {
				return
			}
			if job.connection.transport != nil {
				t.Error("unproven admission created a transport")
			}
			closed := make(chan struct{})
			go func() { f.manager.Close(); close(closed) }()
			if !inboundRetirementAwait(t, closed, "Manager.Close must not join a blocked external Wake") {
				f.releaseWake()
				inboundRetirementAwait(t, closed, "Close joined after releasing test callback")
				return
			}
			if !inboundRetirementAwait(t, f.oldOwner.done, "Close joined the original runner") || !inboundRetirementAwait(t, f.oldOwner.signalDone, "Close joined the actual signal worker") {
				return
			}
			select {
			case <-f.oldOwner.transport.Done():
			default:
				t.Error("Close returned before closing the actual old Pion transport")
			}
			f.releaseWake()
			inboundRetirementAwait(t, f.woke, "test released and joined its own Wake callback")
		})
	}
}
