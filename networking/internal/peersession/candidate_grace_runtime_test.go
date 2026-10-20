package peersession

import (
	"context"
	"testing"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func prepareGraceResume(t *testing.T, fixture *browserCandidateFixture, generation uint64) *session {
	t.Helper()
	next, err := fixture.manager.reserveCandidate(fixture.pairID, generation, false, true)
	if err != nil {
		t.Fatal(err)
	}
	request := *next.prepare
	request.Registration, request.ToCoreInstanceID = fixture.fence, fixture.remoteCore
	request.PreviousAttemptID, request.PreviousGeneration = next.predecessor.lease.AttemptID, next.predecessor.lease.Generation
	next.prepare = &request
	ticket := signedCandidate(request, fixture.manager.config.Device.DeviceID, fixture.manager.config.CoreInstanceID, fixture.authority)
	if err := fixture.manager.installCandidateTicket(next, ticket); err != nil {
		t.Fatal(err)
	}
	next.result.State = State{PairID: next.PairID, AttemptID: ticket.Lease.AttemptID, Generation: generation, Stage: "starting-runtime"}
	return next
}

// A real target negotiation for the production runCandidate regression. The
// small HTTP/WS oracle belongs to the test; all transport, mux and staging code
// is the ordinary production composition.
func graceCandidateTarget(t *testing.T, f *graceFixture, remote *peer.Transport, binding runtimebridge.Binding) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		owner := func(context.Context, string) (runtimebridge.Binding, error) { return binding, nil }
		install := func(mux *peer.Mux, value runtimebridge.Binding) (*runtimebridge.Gateway, *runtimebridge.Endpoint, error) {
			return runtimebridge.Attach(f.manager.ctx, mux, value, false, nil)
		}
		_, endpoint, mux, _, _, err := runtimebridge.Establish(f.manager.ctx, remote, f.next.lease, false, true, false, runtimebridge.WorkbenchOwners{Open: owner}, install)
		if endpoint != nil {
			t.Cleanup(endpoint.Close)
		}
		if mux != nil {
			t.Cleanup(func() { mux.Close() })
		}
		done <- err
	}()
	return done
}
