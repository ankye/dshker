package runtimebridge

import (
	"context"

	"github.com/ankye/dshker/networking/internal/peer"
)

// Attach mutates the pair gateway only inside the current attempt's owner gate.
func Attach(ctx context.Context, mux *peer.Mux, binding Binding, initiator bool, attachment *Endpoint) (*Gateway, *Endpoint, error) {
	// Without a workbench there is nothing to proxy, so no endpoint and no gateway
	// are built — but the transport and its mux are established and returned, and
	// that is what being connected means. Attaching a workbench later is the job of
	// the next Establish for this pair, which replaces the session in place.
	if _, usable := binding.Endpoint(); usable != nil {
		// A pair that had a workbench before keeps its attachment, and with it the
		// stable address a tab may already be showing. That attachment must not be
		// left pointing at the session it held previously: this reconnect replaces
		// it, and the old mux is about to die with the old session. Detaching drops
		// the dead session's pooled connections and tells the listening side the
		// address currently serves nothing, instead of leaving an address that
		// answers every request with a failure while the UI reports ready.
		if attachment != nil {
			attachment.Detach(attachment.CurrentMux())
		}
		return nil, attachment, nil
	}
	var gateway *Gateway
	var err error
	if attachment == nil {
		attachment, err = NewEndpoint(mux, binding)
		if err != nil {
			mux.Close()
			return nil, nil, err
		}
		if initiator {
			gateway, err = OpenBrowserEndpoint(ctx, attachment)
		} else {
			gateway, err = ServeTargetEndpoint(ctx, attachment)
		}
		if err != nil {
			attachment.Close()
			mux.Close()
			return nil, nil, err
		}
	} else if err = attachment.Replace(mux, binding); err != nil {
		mux.Close()
		return nil, nil, err
	}
	return gateway, attachment, nil
}
