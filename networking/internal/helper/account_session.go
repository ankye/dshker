package helper

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// This is the existing shell/core secret key and format. It records the actual
// selected login session; a device certificate's static owner cannot replace it.
const accountSessionPrefix = "peer-user-session:"

type persistedAccountSession struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
}

func (host *Host) sessionStore() (secret.Store, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.deviceKeys == nil {
		return nil, secret.ErrUnavailable
	}
	return host.deviceKeys, nil
}

func (host *Host) readAccountSession(serviceID string) (persistedAccountSession, bool, error) {
	if !protocol.ValidID(serviceID) {
		return persistedAccountSession{}, false, errors.New("p2p.invalid_request")
	}
	store, err := host.sessionStore()
	if err != nil {
		return persistedAccountSession{}, false, err
	}
	body, err := store.Get(accountSessionPrefix + serviceID)
	if errors.Is(err, secret.ErrMissing) {
		return persistedAccountSession{}, false, nil
	}
	if err != nil {
		return persistedAccountSession{}, false, secret.ErrRead
	}
	defer clear(body)
	var session persistedAccountSession
	if protocol.DecodeExact(body, &session) != nil || !validSession(session) {
		return session, false, errors.New("p2p.invalid_user_session")
	}
	return session, true, nil
}

func validSession(session persistedAccountSession) bool {
	decoded, err := hex.DecodeString(session.Token)
	return err == nil && len(decoded) == 32 && session.Token == hex.EncodeToString(decoded) && session.ExpiresAt > 0 && session.ExpiresAt <= 1<<53-1
}

func (host *Host) saveAccountSession(serviceID string, session persistedAccountSession) error {
	if !protocol.ValidID(serviceID) || !validSession(session) {
		return errors.New("p2p.invalid_user_session")
	}
	store, err := host.sessionStore()
	if err != nil {
		return err
	}
	body, err := json.Marshal(session)
	if err != nil {
		return errors.New("p2p.invalid_user_session")
	}
	defer clear(body)
	if err := store.Set(accountSessionPrefix+serviceID, body); err != nil {
		return secret.ErrWrite
	}
	readback, exists, err := host.readAccountSession(serviceID)
	if err != nil {
		return err
	}
	if !exists || readback != session {
		return secret.ErrWrite
	}
	return nil
}

func (host *Host) deleteAccountSession(serviceID string) error {
	store, err := host.sessionStore()
	if err != nil {
		return err
	}
	if err := store.Delete(accountSessionPrefix + serviceID); err != nil {
		return secret.ErrDelete
	}
	_, exists, err := host.readAccountSession(serviceID)
	if err != nil {
		return err
	}
	if exists {
		return secret.ErrDelete
	}
	return nil
}

// Production callers own account.mu through selection and registration admission.
func (account *account) selectedAccount(ctx context.Context) (string, error) {
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil || !exists {
		return "", err
	}
	client, err := account.authenticationClientLocked(ctx)
	if err != nil {
		return "", err
	}
	user, err := client.CurrentUser(ctx, session.Token)
	if err != nil {
		return "", err
	}
	if !protocol.ValidID(user.UserID) || user.Username == "" {
		return "", errors.New("p2p.invalid_user_session")
	}
	if session.ExpiresAt <= time.Now().Unix() {
		return "", errors.New("p2p.user_session_expired")
	}
	if err := checkBootstrapContext(ctx); err != nil {
		return "", err
	}
	current, stillExists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return "", err
	}
	if !stillExists || current != session {
		return "", errors.New("p2p.user_scope_mismatch")
	}
	account.rememberToken(session.Token)
	return user.UserID, nil
}

func (account *account) confirmLogin(ctx context.Context, session controlplane.UserSession) error {
	client, err := account.authenticationClientLocked(ctx)
	if err != nil {
		return err
	}
	current, err := client.CurrentUser(ctx, session.Token)
	if err != nil {
		return err
	}
	if current != session.User || !protocol.ValidID(current.UserID) || current.Username == "" {
		return errors.New("p2p.user_scope_mismatch")
	}
	if session.ExpiresAt <= time.Now().Unix() {
		return errors.New("p2p.user_session_expired")
	}
	if err := account.host.saveAccountSession(account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		return err
	}
	account.rememberToken(session.Token)
	return nil
}

func (account *account) confirmCurrentSession(token string) error {
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return err
	}
	if !exists {
		return errors.New("p2p.user_login_required")
	}
	if session.Token != token {
		return errors.New("p2p.user_scope_mismatch")
	}
	if session.ExpiresAt <= time.Now().Unix() {
		return errors.New("p2p.user_session_expired")
	}
	return nil
}
