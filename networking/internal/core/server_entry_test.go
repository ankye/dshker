package core

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func TestPeerEntryIsPublishedAndRoutedToItsOwner(t *testing.T) {
	entry, found := localrpc.Lookup("peer.entry")
	if !found || entry.Role != localrpc.RoleShell {
		t.Fatal("peer.entry is not published as a main-to-core read")
	}
	peer := &fakePeer{}
	_, err := (Serve{Peer: peer}).Handle(context.Background(), "peer.entry", json.RawMessage(`{"serviceId":"aaaaaaaaaaaa","data":{"pairId":"bbbbbbbbbbbb","generation":7}}`))
	if err == nil || err.Error() != "p2p.service_unconfigured" || len(peer.handled) != 1 || peer.handled[0] != "peer.entry" {
		t.Fatalf("entry read did not reach its peer owner: handled=%v err=%v", peer.handled, err)
	}
}
