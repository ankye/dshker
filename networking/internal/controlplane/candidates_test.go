package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestCandidateControlEndpointsKeepExactRegistrationAndBusinessScope(t *testing.T) {
	var golden struct {
		PublicKey    []byte                   `json:"publicKey"`
		Ticket       protocol.CandidateTicket `json:"ticket"`
		SigningBytes string                   `json:"signingBytes"`
	}
	body, err := os.ReadFile("../protocol/testdata/candidate-v1.json")
	if err != nil || protocol.DecodeControl(body, &golden) != nil {
		t.Fatal("shared fixture unavailable", err)
	}
	ticket := golden.Ticket
	lease := ticket.Lease
	fence := protocol.RegistrationFence{ServerEpoch: ticket.ServerEpoch, SubscriptionID: protocol.NewNonce(), CoreInstanceID: ticket.FromCoreInstanceID}
	linkRequest := protocol.LinkStateRequest{Registration: fence, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.ToDeviceID}
	link := protocol.LinkState{ServerEpoch: fence.ServerEpoch, CurrentActiveAttemptID: ticket.PreviousAttemptID, CurrentActiveGeneration: ticket.PreviousGeneration, PeerCoreInstanceID: ticket.ToCoreInstanceID, PeerCapabilities: []string{protocol.CapabilityCandidate}}
	prepare := protocol.PrepareCandidate{Registration: fence, AttemptID: lease.AttemptID, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.ToDeviceID, Generation: lease.Generation, PreviousAttemptID: ticket.PreviousAttemptID, PreviousGeneration: ticket.PreviousGeneration, ToCoreInstanceID: ticket.ToCoreInstanceID}
	action := protocol.CandidateAction{Registration: fence, Ticket: ticket}
	stateRequest := protocol.CandidateStateRequest{Registration: fence, AttemptID: lease.AttemptID, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: lease.ToDeviceID}
	state := protocol.CandidateState{Ticket: ticket, Decision: protocol.CandidateDecision{Status: "pending", Lease: lease}, LatestLease: lease, CurrentActiveAttemptID: ticket.PreviousAttemptID, CurrentActiveGeneration: ticket.PreviousGeneration}
	endRequest := protocol.EndCandidate{Registration: fence, Ticket: ticket, Reason: "retired"}
	end := protocol.EndResult{AttemptID: lease.AttemptID, Generation: lease.Generation, Ended: true, Reason: "retired", CurrentActiveAttemptID: lease.AttemptID, CurrentActiveGeneration: lease.Generation}
	identityRequest := protocol.PairIdentityRequest{Registration: fence, UserID: lease.UserID, NetworkID: lease.NetworkID, PairID: protocol.NewID()}
	identity := PairIdentity{Pair: Pair{PairID: identityRequest.PairID, NetworkID: lease.NetworkID, Initiator: lease.FromDeviceID, Target: lease.ToDeviceID, State: "active", Revision: 1}, Initiator: PairDeviceIdentity{DeviceID: lease.FromDeviceID, UserID: lease.UserID, PublicKey: bytes.Repeat([]byte{1}, 32), Name: "source", Presence: "online"}, Target: PairDeviceIdentity{DeviceID: lease.ToDeviceID, UserID: lease.UserID, PublicKey: bytes.Repeat([]byte{2}, 32), Name: "target", Presence: "offline"}}
	for _, test := range []struct {
		path              string
		request, response any
		call              func(*Client) (any, error)
	}{
		{"/v2/links/state", linkRequest, link, func(client *Client) (any, error) { return client.LinkState(context.Background(), linkRequest) }},
		{"/v2/pairs/identity", identityRequest, identity, func(client *Client) (any, error) {
			return client.ScopedPairIdentity(context.Background(), identityRequest)
		}},
		{"/v2/candidates/prepare", prepare, ticket, func(client *Client) (any, error) { return client.PrepareCandidate(context.Background(), prepare) }},
		{"/v2/candidates/ready", action, state, func(client *Client) (any, error) { return client.ReadyCandidate(context.Background(), action) }},
		{"/v2/candidates/commit", action, state, func(client *Client) (any, error) { return client.CommitCandidate(context.Background(), action) }},
		{"/v2/candidates/cancel", action, state, func(client *Client) (any, error) { return client.CancelCandidate(context.Background(), action) }},
		{"/v2/candidates/state", stateRequest, state, func(client *Client) (any, error) { return client.CandidateState(context.Background(), stateRequest) }},
		{"/v2/lease", action, lease, func(client *Client) (any, error) { return client.RenewCandidate(context.Background(), action) }},
		{"/v2/end", endRequest, end, func(client *Client) (any, error) { return client.EndCandidate(context.Background(), endRequest) }},
	} {
		t.Run(test.path, func(t *testing.T) {
			calls := 0
			client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				actual, _ := io.ReadAll(r.Body)
				want, _ := json.Marshal(test.request)
				if r.Method != "POST" || r.URL.Path != test.path || r.Header.Get("Content-Type") != "application/json" || !bytes.Equal(actual, want) {
					t.Error("control request drifted from exact v2 scope/shape")
				}
				json.NewEncoder(w).Encode(test.response)
			}))
			actual, err := test.call(client)
			if err != nil || !reflect.DeepEqual(actual, test.response) || calls != 1 {
				t.Fatal("typed control response drifted or retried another API", actual, err, calls)
			}
		})
	}
}
