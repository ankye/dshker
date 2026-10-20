package helper

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"
)

type selectedSessionScopeKey struct{}
type bootstrapLocalFenceKey struct{}

// This immutable metadata belongs to an existing request/source owner. Session
// identity does not depend on it: ordinary maintenance has no such job fence.
type bootstrapLocalFence struct {
	serviceID  string
	generation uint64
	job        *bootstrapJob
	requireJob bool
}

func withBootstrapLocalFence(ctx context.Context, serviceID string, generation uint64, job *bootstrapJob, requireJob bool) context.Context {
	return context.WithValue(ctx, bootstrapLocalFenceKey{}, bootstrapLocalFence{serviceID, generation, job, requireJob})
}

// selectedSessionScope is a denial fence, never a completed authorization read.
// The prior guard and typed fence are captured once; installing Context cannot
// mutate them or chain the scope's own guard back into itself.
type selectedSessionScope struct {
	host       *Host
	account    *account
	serviceID  string
	lifetime   context.Context
	removal    uint64
	tokenHash  [32]byte
	expiresAt  int64
	hasSession bool
	owner      *bootstrapSessionOwner
	localFence *bootstrapLocalFence
	priorGuard func() error
}

func selectedSessionScopeFromContext(ctx context.Context) (*selectedSessionScope, bool) {
	scope, ok := ctx.Value(selectedSessionScopeKey{}).(*selectedSessionScope)
	return scope, ok && scope != nil
}

// The caller owns account.mu and supplies the exact successfully read native
// record. A lower layer reuses an existing scope; it cannot select a later login.
func (account *account) captureSelectedSessionScopeLocked(ctx context.Context, expected persistedAccountSession) (*selectedSessionScope, error) {
	if !validSession(expected) {
		return nil, errors.New("p2p.invalid_user_session")
	}
	if scope, exists := selectedSessionScopeFromContext(ctx); exists {
		if scope.account != account || !scope.matches(expected, true) {
			return nil, errors.New("p2p.user_scope_mismatch")
		}
		return scope, scope.checkWithPrior(ctx)
	}
	return account.captureSessionScopeLocked(ctx, expected, true)
}

// This convenience is only an operation's pre-first-await entry. Required
// authority never interprets a provider error, corruption or absence as logout.
func (account *account) selectedSessionScopeLocked(ctx context.Context) (*selectedSessionScope, error) {
	if account.host == nil {
		return nil, errors.New("p2p.service_unconfigured")
	}
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("p2p.user_login_required")
	}
	return account.captureSelectedSessionScopeLocked(ctx, session)
}

// Only the exact decoded empty-account restore owner may call this constructor.
// It proves native absence independently; it cannot grant nonempty pins/account.
func (account *account) captureSignedOutRestoreScopeLocked(ctx context.Context, request deviceRestoreRequest) (*selectedSessionScope, error) {
	if request.AccountUserID != "" || request.Pins == nil || len(request.Pins) != 0 {
		return nil, errors.New("p2p.invalid_request")
	}
	if scope, exists := selectedSessionScopeFromContext(ctx); exists {
		if scope.account != account || scope.hasSession {
			return nil, errors.New("p2p.user_scope_mismatch")
		}
		return scope, scope.checkWithPrior(ctx)
	}
	return account.captureSessionScopeLocked(ctx, persistedAccountSession{}, false)
}

func (account *account) captureSessionScopeLocked(ctx context.Context, expected persistedAccountSession, hasSession bool) (*selectedSessionScope, error) {
	if account.host == nil || account.closed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	scope := &selectedSessionScope{host: account.host, account: account, serviceID: account.identity.ServiceID,
		lifetime: account.lifetime, hasSession: hasSession, expiresAt: expected.ExpiresAt, tokenHash: sha256.Sum256([]byte(expected.Token))}
	scope.priorGuard, _ = ctx.Value(bootstrapGuardKey{}).(func() error)
	if fence, exists := ctx.Value(bootstrapLocalFenceKey{}).(bootstrapLocalFence); exists {
		if fence.serviceID != scope.serviceID {
			return nil, errors.New("p2p.user_scope_mismatch")
		}
		scope.localFence = &fence
	}
	if scope.priorGuard != nil {
		if err := scope.priorGuard(); err != nil {
			return nil, err
		}
	}
	host := account.host
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	host.mu.Lock()
	scope.removal = host.removedAt[scope.serviceID]
	host.mu.Unlock()
	if hasSession {
		// Never mint bookkeeping for a different or missing durable session.
		current, exists, err := host.readAccountSession(scope.serviceID)
		if err != nil {
			return nil, err
		}
		if !exists || !scope.matches(current, true) {
			return nil, errors.New("p2p.user_scope_mismatch")
		}
		if current.ExpiresAt <= time.Now().Unix() {
			return nil, errors.New("p2p.user_session_expired")
		}
		scope.owner = host.bootstrapSessionOwnerLocked(scope.serviceID, current)
	}
	if err := scope.checkLocked(ctx); err != nil {
		return nil, err
	}
	return scope, nil
}

func (scope *selectedSessionScope) matches(session persistedAccountSession, exists bool) bool {
	return exists == scope.hasSession && (!exists || scope.tokenHash == sha256.Sum256([]byte(session.Token)) && scope.expiresAt == session.ExpiresAt)
}

// Check checks only this scope. Context and Publish compose its immutable prior
// guard separately, outside bootstrapMu; neither recursively consults Context.
func (scope *selectedSessionScope) Check(ctx context.Context) error {
	scope.host.bootstrapMu.Lock()
	defer scope.host.bootstrapMu.Unlock()
	return scope.checkLocked(ctx)
}

func (scope *selectedSessionScope) checkLocked(ctx context.Context) error {
	if ctx.Err() != nil || scope.host.ctx.Err() != nil || scope.lifetime != nil && scope.lifetime.Err() != nil {
		return errors.New("p2p.request_cancelled")
	}
	scope.host.mu.Lock()
	current := !scope.host.closed && scope.host.accounts[scope.serviceID] == scope.account && scope.host.removedAt[scope.serviceID] == scope.removal
	scope.host.mu.Unlock()
	if !current {
		return errors.New("p2p.service_unconfigured")
	}
	if fence := scope.localFence; fence != nil {
		if scope.host.bootstrapGeneration[scope.serviceID] != fence.generation || fence.requireJob && (fence.job == nil || scope.host.bootstraps[scope.serviceID] != fence.job) {
			return errors.New("p2p.user_scope_mismatch")
		}
	}
	if scope.hasSession && (scope.owner == nil || scope.owner.revoked || scope.host.bootstrapSessionOwners[scope.serviceID] != scope.owner) {
		return errors.New("p2p.user_scope_mismatch")
	}
	session, exists, err := scope.host.readAccountSession(scope.serviceID)
	if err != nil {
		return err
	}
	if !scope.matches(session, exists) {
		return errors.New("p2p.user_scope_mismatch")
	}
	if exists && session.ExpiresAt <= time.Now().Unix() {
		return errors.New("p2p.user_session_expired")
	}
	return nil
}

func (scope *selectedSessionScope) checkWithPrior(ctx context.Context) error {
	if scope.priorGuard != nil {
		if err := scope.priorGuard(); err != nil {
			return err
		}
	}
	return scope.Check(ctx)
}

func (scope *selectedSessionScope) Context(ctx context.Context) context.Context {
	if installed, exists := selectedSessionScopeFromContext(ctx); exists && installed == scope {
		// A later owner may have strengthened this same context (for example
		// canonical adoption). Reinstalling cannot erase that additional guard.
		return ctx
	}
	ctx = context.WithValue(ctx, selectedSessionScopeKey{}, scope)
	return context.WithValue(ctx, bootstrapGuardKey{}, func() error { return scope.checkWithPrior(ctx) })
}

// Publish linearizes only with local logout/generation publication. Host state
// is checked under Host.mu then released: this is not a global Forget/Close or
// remote transaction. Callback may only synchronously commit prepared store/view
// data, never acquire Manager/Host, emit, announce, perform I/O requests or join.
func (scope *selectedSessionScope) Publish(ctx context.Context, publish func() error) error {
	if publish == nil {
		return errors.New("p2p.invalid_request")
	}
	if err := scope.checkPriorContext(ctx); err != nil {
		return err
	}
	scope.host.bootstrapMu.Lock()
	defer scope.host.bootstrapMu.Unlock()
	if err := scope.checkLocked(ctx); err != nil {
		return err
	}
	return publish()
}

func (scope *selectedSessionScope) checkPriorContext(ctx context.Context) error {
	if installed, exists := selectedSessionScopeFromContext(ctx); exists {
		if installed != scope {
			return errors.New("p2p.user_scope_mismatch")
		}
		guard, valid := ctx.Value(bootstrapGuardKey{}).(func() error)
		if !valid || guard == nil {
			return errors.New("p2p.user_scope_mismatch")
		}
		if err := guard(); err != nil {
			return err
		}
	} else if scope.priorGuard != nil {
		if err := scope.priorGuard(); err != nil {
			return err
		}
	}
	return nil
}

// Only a completed AfterWrite owner derives background work. It keeps the exact
// selected owner and lifecycle, never rereads a replacement session, and drops
// only the completed caller/job dependency. Fresh HTTP reads remain mandatory.
func (scope *selectedSessionScope) Background(ctx context.Context) (*selectedSessionScope, error) {
	if err := scope.checkPriorContext(ctx); err != nil {
		return nil, err
	}
	if err := scope.Check(ctx); err != nil {
		return nil, err
	}
	derived := *scope
	derived.priorGuard, derived.localFence = nil, nil
	return &derived, nil
}
