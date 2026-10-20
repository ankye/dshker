package helper

import (
	"context"
	"errors"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
)

// Capture only local bookkeeping before waiting for account.mu. The actual
// constructor below still proves the exact native session before its first HTTP.
func (host *Host) selectedCallerContext(ctx context.Context, account *account, generation uint64, session persistedAccountSession, hasSession bool, sourceErr error) context.Context {
	scope := restoreCallerScope{generation: generation, session: session, hasSession: hasSession, err: sourceErr}
	id := account.identity.ServiceID
	host.bootstrapMu.Lock()
	if scope.err == nil {
		current, exists, err := host.readAccountSession(id)
		if err != nil {
			scope.err = err
		} else if host.bootstrapGeneration[id] != generation || exists != hasSession || current != session {
			scope.err = errors.New("p2p.user_scope_mismatch")
		} else if exists {
			scope.sessionOwner = host.bootstrapSessionOwnerLocked(id, current)
		}
	}
	host.bootstrapMu.Unlock()
	return context.WithValue(ctx, restoreCallerKey{}, scope)
}

func (account *account) restoreSessionContextLocked(ctx context.Context, request deviceRestoreRequest) (context.Context, error) {
	if err := account.checkCallerSessionLocked(ctx); err != nil {
		return ctx, err
	}
	var scope *selectedSessionScope
	var err error
	if request.AccountUserID == "" {
		scope, err = account.captureSignedOutRestoreScopeLocked(ctx, request)
	} else {
		scope, err = account.selectedSessionScopeLocked(ctx)
	}
	if err != nil {
		return ctx, err
	}
	return scope.Context(ctx), checkBootstrapContext(scope.Context(ctx))
}

func (account *account) checkCallerSessionLocked(ctx context.Context) error {
	if caller, exists := ctx.Value(restoreCallerKey{}).(restoreCallerScope); exists {
		if caller.err != nil {
			return caller.err
		}
		current, present, err := account.host.readAccountSession(account.identity.ServiceID)
		if err != nil {
			return err
		}
		if present != caller.hasSession || current != caller.session {
			return errors.New("p2p.user_scope_mismatch")
		}
	}
	return nil
}

// A genuine login's scope starts only after confirmLogin has completed its
// independent fresh user read and exact durable write/readback.
func (account *account) confirmedSessionContextLocked(ctx context.Context, session controlplane.UserSession) (context.Context, error) {
	expected := persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}
	scope, err := account.captureSelectedSessionScopeLocked(ctx, expected)
	if err != nil {
		return ctx, err
	}
	return scope.Context(ctx), nil
}

func (account *account) publishRestoreStateLocked(ctx context.Context, publish func() error) error {
	scope, exists := selectedSessionScopeFromContext(ctx)
	if !exists || scope.account != account {
		return errors.New("p2p.user_scope_mismatch")
	}
	return scope.Publish(ctx, publish)
}

func (account *account) finishRestoreLocked(ctx context.Context) error {
	return account.publishRestoreStateLocked(ctx, func() error {
		account.activationPending = nil
		account.activationSource = nil
		return nil
	})
}

// Caller owns account.mu, not bootstrapMu. This exact unpublished owner is
// detached now; both Handle and headless restore join its completion after unlock.
func (account *account) discardRestoreManagerLocked(manager *peersession.Manager, client *controlplane.Client) {
	completion, _ := manager.FenceAccountForLogout()
	if completion != nil {
		account.authRecoveryJoins = append(account.authRecoveryJoins, completion)
	}
	manager.Close()
	client.Close()
}
