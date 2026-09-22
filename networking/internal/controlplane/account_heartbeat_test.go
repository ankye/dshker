package controlplane

import "testing"

// The heartbeat reports the account currently signed in, because the coordinator
// records presence per (device, account) and authorizes a connection by finding
// both ends online under one shared account.
//
// The account used to be set once, while the device was being restored, and never
// updated when the user signed in afterwards. The machine then reported presence
// for the earlier account: it was online, but a peer looking under the account it
// was itself signed in to found nothing and was refused as p2p.peer_offline while
// both sides displayed as online.
func TestHeartbeatReportsTheCurrentAccount(t *testing.T) {
	client := &Client{}
	if got := client.heartbeat().UserID; got != "" {
		t.Fatalf("a client that signed in nowhere reported %q, want empty", got)
	}
	client.SetAccount("aa00000000a1")
	if got := client.heartbeat().UserID; got != "aa00000000a1" {
		t.Fatalf("heartbeat account = %q, want aa00000000a1", got)
	}
	// Signing in to another account replaces it rather than adding to it: presence
	// is reported for the account in use.
	client.SetAccount("bb00000000b1")
	if got := client.heartbeat().UserID; got != "bb00000000b1" {
		t.Fatalf("heartbeat account after a switch = %q, want bb00000000b1", got)
	}
	// Signing out reports no account, which reads as offline — the truth.
	client.SetAccount("")
	if got := client.heartbeat().UserID; got != "" {
		t.Fatalf("heartbeat account after sign-out = %q, want empty", got)
	}
}
