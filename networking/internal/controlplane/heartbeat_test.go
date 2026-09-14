package controlplane

import (
	"encoding/json"
	"testing"
)

// Presence belongs to an account, so the heartbeat has to name the account this
// machine is signed in to. Signed in nowhere is a real state, not a missing
// field: it means no presence is reported and the machine reads as offline.
func TestHeartbeatCarriesTheSignedInAccount(t *testing.T) {
	client := testClient(t, nil)

	body, err := json.Marshal(client.heartbeat())
	if err != nil {
		t.Fatal(err)
	}
	var sent struct {
		Version      string `json:"version"`
		Platform     string `json:"platform"`
		Architecture string `json:"architecture"`
		UserID       string `json:"userId"`
	}
	if err = json.Unmarshal(body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.UserID != "" {
		t.Fatalf("a fresh client reported account %q, want none", sent.UserID)
	}
	// Unchanged telemetry still travels: the account is added, not substituted.
	client.SetTelemetry(Telemetry{Version: "0.1.39", Platform: "linux", Architecture: "amd64"})
	client.SetAccount("a1b2c3d4e5f6")
	body, err = json.Marshal(client.heartbeat())
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.UserID != "a1b2c3d4e5f6" || sent.Version != "0.1.39" || sent.Platform != "linux" || sent.Architecture != "amd64" {
		t.Fatalf("heartbeat body = %+v, want the account plus the build description", sent)
	}
	// Signing out stops the report rather than leaving the previous account's
	// presence alive under a machine nobody is signed in to.
	client.SetAccount("")
	body, err = json.Marshal(client.heartbeat())
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.UserID != "" {
		t.Fatalf("after signing out the heartbeat still named %q", sent.UserID)
	}
}

// The client is read by the heartbeat goroutine while the shell changes the
// account, so the accessors must be safe under -race.
func TestAccountAccessorsAreConcurrencySafe(t *testing.T) {
	client := testClient(t, nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for index := 0; index < 200; index++ {
			client.SetAccount("a1b2c3d4e5f6")
			_ = client.heartbeat()
			client.SetAccount("")
		}
	}()
	for index := 0; index < 200; index++ {
		_ = client.heartbeat()
	}
	<-done
}
