package controlplane

import (
	"context"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func (client *Client) control(ctx context.Context, path string, request, result any) error {
	data, err := client.response(ctx, "POST", path, "", request)
	if err != nil {
		return err
	}
	return protocol.DecodeControl(data, result)
}

func (client *Client) LinkState(ctx context.Context, request protocol.LinkStateRequest) (protocol.LinkState, error) {
	var result protocol.LinkState
	err := client.control(ctx, "/v2/links/state", request, &result)
	return result, err
}

func (client *Client) ScopedPairIdentity(ctx context.Context, request protocol.PairIdentityRequest) (PairIdentity, error) {
	var result PairIdentity
	err := client.control(ctx, "/v2/pairs/identity", request, &result)
	return result, err
}

func (client *Client) PrepareCandidate(ctx context.Context, request protocol.PrepareCandidate) (protocol.CandidateTicket, error) {
	var result protocol.CandidateTicket
	err := client.control(ctx, "/v2/candidates/prepare", request, &result)
	return result, err
}

func (client *Client) ReadyCandidate(ctx context.Context, request protocol.CandidateAction) (protocol.CandidateState, error) {
	return client.candidateAction(ctx, "/v2/candidates/ready", request)
}

func (client *Client) CommitCandidate(ctx context.Context, request protocol.CandidateAction) (protocol.CandidateState, error) {
	return client.candidateAction(ctx, "/v2/candidates/commit", request)
}

func (client *Client) CancelCandidate(ctx context.Context, request protocol.CandidateAction) (protocol.CandidateState, error) {
	return client.candidateAction(ctx, "/v2/candidates/cancel", request)
}

func (client *Client) candidateAction(ctx context.Context, path string, request protocol.CandidateAction) (protocol.CandidateState, error) {
	var result protocol.CandidateState
	err := client.control(ctx, path, request, &result)
	return result, err
}

func (client *Client) CandidateState(ctx context.Context, request protocol.CandidateStateRequest) (protocol.CandidateState, error) {
	var result protocol.CandidateState
	err := client.control(ctx, "/v2/candidates/state", request, &result)
	return result, err
}

func (client *Client) RenewCandidate(ctx context.Context, request protocol.CandidateAction) (Lease, error) {
	var result Lease
	err := client.control(ctx, "/v2/lease", request, &result)
	return result, err
}

func (client *Client) EndCandidate(ctx context.Context, request protocol.EndCandidate) (protocol.EndResult, error) {
	var result protocol.EndResult
	err := client.control(ctx, "/v2/end", request, &result)
	return result, err
}
