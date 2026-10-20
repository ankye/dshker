package peersession

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type graceFixture struct {
	*browserCandidateFixture
	old, next     *session
	ready, commit atomic.Int32
}

// Signed control receipts and real unconnected Pion transports give the owner
// tests controllable non-ready/non-terminal facts without waiting out ICE time.
// The separate browser regression exercises connected HTTP/WS and its real mux.
func newGraceFixture(t *testing.T, initiator bool) *graceFixture {
	return newGraceFixtureTTL(t, initiator, 0)
}

func newGraceFixtureTTL(t *testing.T, initiator bool, ttl time.Duration) *graceFixture {
	t.Helper()
	f := &graceFixture{browserCandidateFixture: newBrowserCandidateFixture(t)}
	manager := f.manager
	local, remote := manager.config.Device.DeviceID, manager.pins[f.pairID].Target.DeviceID
	from, target, fromCore, targetCore := local, remote, manager.config.CoreInstanceID, f.remoteCore
	if !initiator {
		from, target, fromCore, targetCore = remote, local, f.remoteCore, manager.config.CoreInstanceID
	}
	makeOwner := func(generation uint64, previous *session) *session {
		request := protocol.PrepareCandidate{Registration: f.fence, AttemptID: protocol.NewNonce(), UserID: manager.accountUserID, NetworkID: manager.pins[f.pairID].Pair.NetworkID, PairID: target, Generation: generation, ToCoreInstanceID: targetCore}
		if previous != nil {
			request.PreviousAttemptID, request.PreviousGeneration = previous.lease.AttemptID, previous.lease.Generation
		}
		ticket := signedCandidate(request, from, fromCore, f.authority)
		if ttl > 0 {
			ticket.PrepareDeadline = time.Now().Add(ttl).Unix()
			ticket.Lease.ExpiresAt = ticket.PrepareDeadline
			ticket.Lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.authority, ticket.Lease.SigningBytes()))
			ticket.Sign(f.authority)
		}
		connection := newSession(manager.ctx)
		connection.PairID, connection.ticket, connection.lease = f.pairID, &ticket, ticket.Lease
		connection.requestWorkbench = true
		options := peer.TransportOptions{UserID: ticket.Lease.UserID, NetworkID: ticket.Lease.NetworkID, STUNAddress: f.stunAddress, LocalDeviceID: local, PeerDeviceID: remote, PrivateKey: manager.config.PrivateKey, PeerKey: f.remotePrivate.Public().(ed25519.PublicKey), ServiceKey: manager.config.Authority.PublicKey, Scope: protocol.SignalScope{AttemptID: ticket.Lease.AttemptID, PairID: target, Generation: generation, FromDeviceID: from, ToDeviceID: target}, Revision: ticket.Lease.Revision, Lease: ticket.Lease, Ticket: &ticket}
		var err error
		connection.transport, err = peer.NewTransport(connection.ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { closeCandidateTransport(t, connection); manager.finish(connection.PairID, connection) })
		return connection
	}
	f.old = makeOwner(1, nil)
	f.old.promoted = true
	f.old.result.State = State{PairID: f.pairID, AttemptID: f.old.lease.AttemptID, Generation: 1, RuntimeGeneration: 1, Stage: "suspended"}
	f.next = makeOwner(2, f.old)
	f.next.predecessor, f.next.predecessorWasSuspended = f.old, true
	if initiator {
		manager.sessions[f.pairID], manager.candidates[f.pairID] = f.old, f.next
	} else {
		manager.inbound[f.pairID], manager.inboundCandidates[f.pairID] = f.old, f.next
	}
	return f
}

func (f *graceFixture) wait(t *testing.T) <-chan error {
	t.Helper()
	answer := make(chan error, 1)
	go func() { answer <- f.manager.awaitCandidateGrace(f.next) }()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		f.manager.mu.Lock()
		captured := f.next.graceOwner != nil
		f.manager.mu.Unlock()
		if captured {
			return answer
		}
		select {
		case err := <-answer:
			t.Fatal("gate returned before capturing its exact owner", err)
		case <-f.manager.ctx.Done():
			t.Fatal(f.manager.ctx.Err())
		case <-ticker.C:
		}
	}
}

func graceResult(t *testing.T, ctx context.Context, done <-chan error, code string) {
	t.Helper()
	select {
	case err := <-done:
		if (code == "" && err != nil) || (code != "" && (err == nil || err.Error() != code)) {
			t.Fatalf("gate error=%v, want %q", err, code)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestCandidateGraceBothDirectionsWaitForActualTerminal(t *testing.T) {
	for _, initiator := range []bool{true, false} {
		t.Run(map[bool]string{true: "initiated", false: "answered"}[initiator], func(t *testing.T) {
			f := newGraceFixture(t, initiator)
			done := f.wait(t)
			// The old transport is non-ready with no grace timer; this alone cannot
			// release the gate. No Ready/Commit is allowed before its termination.
			select {
			case err := <-done:
				t.Fatal("non-ready/non-terminal predecessor released Ready", err)
			default:
			}
			f.old.cancel()
			graceResult(t, f.manager.ctx, done, "")
			if *f.next.ticket != f.next.graceOwner.ticket {
				t.Fatal("waiting changed signed ticket or preparation deadline")
			}
		})
	}
}

func TestCandidateGraceRejectsChangedExactScopeAtWakeAndCommit(t *testing.T) {
	for _, scope := range []string{"previous-attempt", "previous-generation", "pointer", "direction", "account", "pin", "pin-key", "subscription", "core", "remote-core", "slot", "remote-replaced"} {
		t.Run(scope, func(t *testing.T) {
			f := newGraceFixture(t, true)
			done := f.wait(t)
			f.manager.mu.Lock()
			switch scope {
			case "previous-attempt":
				f.next.ticket.PreviousAttemptID = protocol.NewNonce()
			case "previous-generation":
				f.next.ticket.PreviousGeneration++
			case "pointer":
				f.next.predecessor = newSession(f.manager.ctx)
			case "direction":
				f.next.lease.FromDeviceID, f.next.lease.ToDeviceID = f.next.lease.ToDeviceID, f.next.lease.FromDeviceID
			case "account":
				f.manager.accountUserID = "ffffffffffff"
			case "pin":
				pin := f.manager.pins[f.pairID]
				pin.Pair.Revision++
				f.manager.pins[f.pairID] = pin
			case "pin-key":
				f.manager.pins[f.pairID].Target.PublicKey[0] ^= 1
			case "subscription":
				f.manager.signals.active = candidateSubscriptionFor(f.manager.config.CoreInstanceID)
			case "core":
				f.manager.config.CoreInstanceID = protocol.NewNonce()
			case "remote-core":
				f.old.ticket.ToCoreInstanceID = protocol.NewNonce()
			case "slot":
				f.manager.candidates[f.pairID] = newSession(f.manager.ctx)
			case "remote-replaced":
				f.old.remoteReplaced = true
			}
			barrierErr := f.manager.candidateGraceCommitLocked(f.next)
			f.manager.mu.Unlock()
			f.old.cancel()
			select {
			case err := <-done:
				if err == nil || barrierErr == nil {
					t.Fatal("stale scope crossed wait or dispatch barrier", err, barrierErr)
				}
			case <-f.manager.ctx.Done():
				t.Fatal(f.manager.ctx.Err())
			}
		})
	}
}

func TestCandidateGraceExcludedReplacementAndWorkbenchUpgrade(t *testing.T) {
	for _, reason := range []string{"remote-core", "workbench-upgrade", "explicit"} {
		t.Run(reason, func(t *testing.T) {
			f := newGraceFixture(t, true)
			switch reason {
			case "remote-core":
				f.old.remoteReplaced = true
			case "workbench-upgrade":
				f.old.result.State.RuntimeGeneration = 0
				f.old.result.State.Error = "p2p.runtime_unavailable"
			case "explicit":
				f.next.predecessorWasSuspended = false
			}
			if err := f.manager.awaitCandidateGrace(f.next); err != nil || f.next.graceOwner != nil {
				t.Fatal("distinct replacement path entered grace gate", err)
			}
		})
	}
}

func TestCandidateGraceWaitRetainsCommittedDecisionAndOriginalExpiry(t *testing.T) {
	for _, event := range []string{"committed", "cancelled", "candidate-terminal", "mux-terminal"} {
		t.Run(event, func(t *testing.T) {
			f := newGraceFixture(t, true)
			if event == "mux-terminal" {
				mux, err := peer.NewMux(f.next.transport, peer.StreamScope{AttemptID: f.next.lease.AttemptID, Generation: f.next.lease.Generation, Initiator: true})
				if err != nil {
					t.Fatal(err)
				}
				f.next.mux = mux
			}
			done := f.wait(t)
			code := ""
			switch event {
			case "committed":
				if err := f.manager.validateCandidateState(f.next, committedHandoffState(*f.next.ticket)); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				f.next.requestCancel()
				code = "p2p.connection_cancelled"
			case "candidate-terminal":
				f.next.transport.Close()
				code = "p2p.direct_closed"
			case "mux-terminal":
				f.next.mux.Close()
				code = "p2p.not_connected"
			}
			graceResult(t, f.manager.ctx, done, code)
		})
	}
}

func TestCandidateGraceSignedPreparationExpiryRemainsOriginalBound(t *testing.T) {
	f := newGraceFixtureTTL(t, true, 2*time.Second)
	ticket := *f.next.ticket
	if err := ticket.Verify(f.manager.config.Authority.PublicKey); err != nil {
		t.Fatal(err)
	}
	done := f.wait(t)
	graceResult(t, f.manager.ctx, done, "p2p.candidate_expired")
	if *f.next.ticket != ticket || f.next.cancellationRequested() {
		t.Fatal("expiry recreated or changed the candidate")
	}
}

func TestCandidateGraceLeaseUpdateDoesNotResetPreparationOrGate(t *testing.T) {
	f := newGraceFixture(t, true)
	ticket := *f.next.ticket
	done := f.wait(t)
	lease := ticket.Lease
	lease.ExpiresAt += 15
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.authority, lease.SigningBytes()))
	if err := f.next.transport.UpdateLease(lease); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		t.Fatal("renewal released the old recovery owner", err)
	default:
	}
	f.old.cancel()
	graceResult(t, f.manager.ctx, done, "")
	if *f.next.ticket != ticket || f.next.transport.Diagnostics().LeaseExpiresAt != lease.ExpiresAt {
		t.Fatal("renewal changed immutable ticket or failed to retain its signed lease")
	}
}
