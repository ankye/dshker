package helper

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type passwordResetRequest struct {
	Email    string `json:"email"`
	Code     string `json:"code"`
	Password string `json:"password"`
}

func (account *account) resetUserPassword(ctx context.Context, data json.RawMessage) (any, error) {
	var request passwordResetRequest
	if protocol.DecodeExact(data, &request) != nil || !controlplane.ValidPasswordReset(request.Email, request.Code, request.Password) {
		return nil, errors.New("p2p.invalid_request")
	}
	account.mu.Lock()
	result, completion, err := account.resetUserPasswordLocked(ctx, request)
	account.mu.Unlock()
	// Manager callbacks may need account.mu. Join only after releasing it, just
	// as the existing explicit logout owner does.
	if completion != nil {
		completion.Wait()
	}
	return result, err
}

// A reset code names an account independently of the selected login. Only a
// fresh server-backed email match authorizes removing local selected authority.
func (account *account) resetUserPasswordLocked(ctx context.Context, request passwordResetRequest) (any, *peersession.AccountRecoveryCompletion, error) {
	if ctx.Err() != nil || account.host.ctx.Err() != nil || account.lifetime != nil && account.lifetime.Err() != nil {
		return nil, nil, errors.New("p2p.request_cancelled")
	}
	if account.closed || account.base == nil {
		return nil, nil, errors.New("p2p.service_unconfigured")
	}
	scope, err := account.passwordResetSessionScopeLocked(ctx, request.Email)
	if err != nil {
		return nil, nil, err
	}
	if err := account.base.ResetPassword(ctx, request.Email, request.Code, request.Password); err != nil {
		return nil, nil, err
	}
	if scope == nil {
		return struct {
			Reset bool `json:"reset"`
		}{true}, nil, nil
	}
	revoked := false
	err = scope.Publish(ctx, func() error {
		scope.owner.revoked = true
		revoked = true
		return account.host.deleteAccountSession(account.identity.ServiceID)
	})
	if !revoked {
		return nil, nil, err
	}
	var completion *peersession.AccountRecoveryCompletion
	var fenceErr error
	if account.manager != nil {
		completion, fenceErr = account.manager.FenceAccountForLogout()
	} else if account.client != nil {
		account.client.SetAccount("")
	}
	account.forgetToken()
	if err != nil {
		return nil, completion, err
	}
	if fenceErr != nil {
		return nil, completion, fenceErr
	}
	return struct {
		Reset bool `json:"reset"`
	}{true}, completion, nil
}

func (account *account) passwordResetSessionScopeLocked(ctx context.Context, email string) (*selectedSessionScope, error) {
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil || !exists {
		return nil, err
	}
	// An expired record does not prove which account the reset code belongs to.
	// Leave it for ordinary restore refusal rather than deleting another login.
	if session.ExpiresAt <= time.Now().Unix() {
		return nil, nil
	}
	client, err := account.authenticationClientLocked(ctx)
	if err != nil {
		return nil, err
	}
	current, err := client.CurrentUser(ctx, session.Token)
	if err != nil {
		if err.Error() == "p2p.user_unauthorized" || err.Error() == "p2p.user_session_expired" {
			return nil, nil
		}
		return nil, err
	}
	if !protocol.ValidID(current.UserID) || current.Username == "" {
		return nil, errors.New("p2p.invalid_server_response")
	}
	if current.Username != email {
		return nil, nil
	}
	return account.captureSelectedSessionScopeLocked(ctx, session)
}
