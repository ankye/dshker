package helper

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// The private renewal owner serializes with login/restore while the selected
// session scope independently fences logout admitted outside account.mu.
func (account *account) renewUserSession(ctx context.Context, data json.RawMessage) (any, error) {
	var request struct {
		Token string `json:"token"`
	}
	if protocol.DecodeExact(data, &request) != nil {
		return nil, errors.New("p2p.invalid_request")
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	stored, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("p2p.user_login_required")
	}
	if stored.Token != request.Token {
		return nil, errors.New("p2p.user_scope_mismatch")
	}
	scope, err := account.captureRenewalSessionScopeLocked(ctx, stored)
	if err != nil {
		return nil, err
	}
	ctx = scope.Context(ctx)
	client, err := account.authenticationClientLocked(ctx)
	if err != nil {
		return nil, err
	}
	current, err := client.CurrentUser(ctx, request.Token)
	if fence := checkBootstrapContext(ctx); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	session, err := client.RenewUserSession(ctx, request.Token)
	if fence := checkBootstrapContext(ctx); fence != nil {
		return nil, fence
	}
	if err != nil {
		return nil, err
	}
	if session.User != current || session.ExpiresAt < scope.expiresAt {
		return nil, errors.New("p2p.user_scope_mismatch")
	}
	if err := scope.Publish(ctx, func() error {
		return account.host.saveAccountSession(account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt})
	}); err != nil {
		return nil, err
	}
	// The committed expiry supersedes this scope. Rechecking the old scope here
	// would reject our own successful write; the caller adopts only this reply.
	return session, nil
}
