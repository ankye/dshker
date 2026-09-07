package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestLeaseGoldenUserNetworkAndTampering(t *testing.T) {
	key := ed25519.NewKeyFromSeed(make([]byte, 32))
	public := key.Public().(ed25519.PublicKey)
	user, network, pair, attempt, first, second := strings.Repeat("1", 32), strings.Repeat("2", 32), strings.Repeat("3", 32), strings.Repeat("4", 32), strings.Repeat("5", 32), strings.Repeat("6", 32)
	now := time.Unix(1800000000, 0)
	lease := Lease{Version: 1, ServiceID: KeyID(public), UserID: user, NetworkID: network, PairID: pair, AttemptID: attempt, FromDeviceID: first, ToDeviceID: second, Generation: 1, Revision: 3, ExpiresAt: 1800000060, Permission: "dsh-session"}
	expected := fmt.Sprintf("[\"dshker.lease.v1\",1,\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",1,3,1800000060,\"dsh-session\"]", KeyID(public), user, network, pair, attempt, first, second)
	if string(lease.SigningBytes()) != expected {
		t.Fatal("lease canonical field order changed")
	}
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, lease.SigningBytes()))
	scope := SignalScope{AttemptID: attempt, FromDeviceID: first, ToDeviceID: second, PairID: pair, Generation: 1}
	if err := lease.Verify(public, scope, user, network, 3, now); err != nil {
		t.Fatal(err)
	}
	if err := lease.Verify(public, scope, NewID(), network, 3, now); err == nil {
		t.Fatal("cross-user lease accepted")
	}
	if err := lease.Verify(public, scope, user, NewID(), 3, now); err == nil {
		t.Fatal("cross-network lease accepted")
	}
	changed := lease
	changed.NetworkID = NewID()
	if err := changed.Verify(public, scope, user, changed.NetworkID, 3, now); err == nil {
		t.Fatal("tampered signed network accepted")
	}
	if err := lease.Verify(public, scope, user, network, 3, now.Add(time.Minute)); err == nil {
		t.Fatal("expired scoped lease accepted")
	}
}
