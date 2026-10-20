package peer

import "testing"

func TestLiveLifecyclePublishesSuspensionWithoutEndingTransport(t *testing.T) {
	transport := newGraceTestTransport()
	transport.lifecycle = make(chan struct{}, 1)
	defer transport.cancel()
	defer transport.endGrace()
	transport.beginGrace()
	select {
	case <-transport.Changes():
	default:
		t.Fatal("disconnect did not notify the lifecycle owner")
	}
	first := transport.LiveState()
	if !first.Suspended || first.Ready || transport.ctx.Err() != nil {
		t.Fatalf("disconnect destroyed or falsely readied the primary: %+v", first)
	}
	transport.beginGrace()
	if transport.LiveState().Window != first.Window {
		t.Fatal("repeated disconnect extended the primary window")
	}
	transport.endGrace()
	if state := transport.LiveState(); state.Suspended || state.Window <= first.Window {
		t.Fatalf("recovery retained the old disconnect fence: %+v", state)
	}
	select {
	case <-transport.Changes():
	default:
		t.Fatal("recovery did not notify the lifecycle owner")
	}
	transport.expireGrace(first.Window)
	if transport.ctx.Err() != nil {
		t.Fatal("a stale expiry ended the recovered primary")
	}
}
