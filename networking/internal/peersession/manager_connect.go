package peersession

import (
	"context"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func (manager *Manager) Connect(ctx context.Context, pairID string, generation uint64, requestWorkbench bool) (Connected, error) {
	return manager.connectCandidate(ctx, pairID, generation, requestWorkbench, !requestWorkbench)
}

// Reconnect restores an authorized transport and any previously admitted
// workbench intent, but grants only permission to bind an already-running DSH.
func (manager *Manager) Reconnect(ctx context.Context, pairID string, generation uint64) (Connected, error) {
	return manager.connectCandidate(ctx, pairID, generation, false, true)
}

// namedRefusal reports why an attempt failed.
//
// The renderer only accepts named p2p codes, so an unnamed error is replaced by
// a generic one; a named refusal is passed through. Overwriting every failure
// with one constant made a transport failure and a missing remote runtime
// indistinguishable from the UI, which is exactly the question being asked.
func namedRefusal(err error, transportReady bool) string {
	if code, ok := protocol.Refusal(err); ok {
		return code
	}
	if !transportReady {
		// A deadline here means neither the direct path nor the opaque TURN relay
		// fallback came up, so the honest refusal is that the two networks cannot
		// reach each other.
		return "p2p.direct_unavailable"
	}
	return "p2p.runtime_unavailable"
}
