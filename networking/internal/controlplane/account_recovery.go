package controlplane

import (
	"context"
	"encoding/hex"
	"errors"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// RenewUserSession extends only the supplied live bearer. The coordinator owns
// the returned expiry; an unavailable endpoint never selects another API.
func (client *Client) RenewUserSession(ctx context.Context, token string) (UserSession, error) {
	var session UserSession
	if !validAccountToken(token) {
		return session, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "POST", "/v1/session/renew", token, struct{}{}, &session)
	if err != nil {
		return UserSession{}, err
	}
	if session.Token != token || !protocol.ValidID(session.User.UserID) || session.User.Username == "" || session.ExpiresAt <= time.Now().Unix() || session.ExpiresAt > 1<<53-1 {
		return UserSession{}, errors.New("p2p.invalid_server_response")
	}
	return session, nil
}

var accountEmailPattern = regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)

func validAccountToken(token string) bool {
	decoded, err := hex.DecodeString(token)
	return err == nil && len(decoded) == 32 && token == hex.EncodeToString(decoded)
}

// ResetPassword submits an explicit one-time recovery code without borrowing a
// selected account's bearer or device identity.
func (client *Client) ResetPassword(ctx context.Context, email, code, password string) error {
	if !ValidPasswordReset(email, code, password) {
		return errors.New("p2p.invalid_request")
	}
	var result struct {
		Reset bool `json:"reset"`
	}
	if err := client.call(ctx, "POST", "/v1/password/reset", "", struct {
		Email    string `json:"email"`
		Code     string `json:"code"`
		Password string `json:"password"`
	}{email, code, password}, &result); err != nil {
		return err
	}
	if !result.Reset {
		return errors.New("p2p.invalid_server_response")
	}
	return nil
}

// ValidPasswordReset is shared by the private RPC admission and HTTPS owner.
func ValidPasswordReset(email, code, password string) bool {
	return len(email) <= 254 && accountEmailPattern.MatchString(email) && validAccountToken(code) && utf8.ValidString(password) && utf8.RuneCountInString(password) >= 12 && len(password) <= 72
}
