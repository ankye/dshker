package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// Register must return the created user and must not invent a session: the
// coordinator answers POST /v1/register with the user alone.
func TestRegisterReturnsCreatedUserAndRejectsInvalidResponses(t *testing.T) {
	userID := protocol.NewID()
	var received struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	client := testClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/register" {
			t.Fatalf("unexpected call: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "" {
			t.Fatal("registration must not send an authorization header")
		}
		if json.NewDecoder(request.Body).Decode(&received) != nil {
			t.Fatal("register sent an undecodable body")
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(User{UserID: userID, Username: "alice@example.com"})
	}))
	user, err := client.Register(context.Background(), "alice@example.com", "a-long-password")
	if err != nil {
		t.Fatal(err)
	}
	if user.UserID != userID || user.Username != "alice@example.com" {
		t.Fatalf("register substituted the created user: %+v", user)
	}
	if received.Email != "alice@example.com" || received.Password != "a-long-password" {
		t.Fatalf("register altered the submitted credentials: %+v", received)
	}

	// A response without a usable user id is a protocol failure, not a success.
	refusing := testClient(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(User{UserID: "", Username: "alice@example.com"})
	}))
	if _, err := refusing.Register(context.Background(), "alice@example.com", "a-long-password"); err == nil {
		t.Fatal("accepted a registration response without a valid user id")
	}
}

// UpdateNetworkLimit must reach the coordinator's limit path and carry the
// capacity the server reports back, which requires maxDevices on Network.
func TestUpdateNetworkLimitSendsCapacityAndReadsItBack(t *testing.T) {
	networkID := protocol.NewID()
	client := testClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPatch || request.URL.Path != "/v1/networks/"+networkID+"/limit" {
			t.Fatalf("unexpected call: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer token-value" {
			t.Fatal("capacity change must be authorized")
		}
		var body struct {
			MaxDevices int `json:"maxDevices"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || body.MaxDevices != 20 {
			t.Fatalf("capacity not submitted as sent: %+v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(Network{NetworkID: networkID, UserID: "user-a", Name: "Office", MaxDevices: 20})
	}))
	network, err := client.UpdateNetworkLimit(context.Background(), "token-value", networkID, 20)
	if err != nil {
		t.Fatal(err)
	}
	if network.MaxDevices != 20 {
		t.Fatalf("server capacity was dropped on the way back: %+v", network)
	}
	// A malformed network id never reaches the network.
	if _, err := client.UpdateNetworkLimit(context.Background(), "token-value", "not-an-id", 20); err == nil {
		t.Fatal("accepted an invalid network id")
	}
}
