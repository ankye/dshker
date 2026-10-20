package helper

import (
	"context"
	"encoding/json"
	"errors"
	"log"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// Only this logout owns these four causes, in fixed public priority order:
// selection/HTTP, post-auth validation, durable deletion, local fence. The IPC
// code stays one exact original code; secondary typed diagnostics are bounded.
type accountLogoutFailure struct {
	primary error
	causes  [4]error
}

func (failure *accountLogoutFailure) Error() string {
	return failure.primary.Error()
}

func (failure *accountLogoutFailure) Unwrap() []error {
	causes := make([]error, 0, len(failure.causes))
	for _, cause := range failure.causes {
		if cause != nil {
			causes = append(causes, cause)
		}
	}
	return causes
}

func (account *account) logoutResult(result any, causes [4]error) (any, error) {
	var codes [4]string
	var primary error
	for index, cause := range causes {
		if cause != nil {
			if primary == nil {
				primary = cause
			}
			codes[index] = "unclassified"
			if code, ok := protocol.Refusal(cause); ok {
				codes[index] = code
			}
		}
	}
	if primary == nil {
		return result, nil
	}
	log.Printf("[p2p] logout incomplete service=%s auth=%s post=%s durable=%s fence=%s", account.identity.ServiceID, codes[0], codes[1], codes[2], codes[3])
	return nil, &accountLogoutFailure{primary: primary, causes: causes}
}

// The exact durable selected token captures the old local owner before HTTP.
// Caller holds account.mu. No failed selection/request retries through base;
// cancellation or invalid device records cannot abandon local-only revocation.
func (account *account) logout(ctx context.Context, data json.RawMessage) (any, error) {
	var request struct {
		Token string `json:"token"`
	}
	if protocol.DecodeExact(data, &request) != nil {
		return nil, errors.New("p2p.invalid_request")
	}
	session, exists, err := account.host.readAccountSession(account.identity.ServiceID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.New("p2p.user_login_required")
	}
	if request.Token != session.Token {
		return nil, errors.New("p2p.user_scope_mismatch")
	}
	client, manager := account.client, account.manager
	userID := ""
	if client != nil {
		userID = client.Account()
	}
	var causes [4]error
	transport, err := account.authenticationClientLocked(ctx)
	causes[0] = err
	var result any
	if err == nil {
		causes[0] = transport.Logout(ctx, request.Token)
		if causes[0] == nil {
			result = struct{}{}
		}
	}
	current, stillExists, readErr := account.host.readAccountSession(account.identity.ServiceID)
	if account.client != client || account.manager != manager || client != nil && client.Account() != userID || readErr == nil && stillExists && current != session {
		causes[1] = errors.New("p2p.user_scope_mismatch")
		return account.logoutResult(result, causes)
	}
	if err == nil {
		_, causes[1] = account.authRecoveryRequiredLocked(ctx)
	}
	if readErr == nil && !stillExists && causes[1] == nil {
		// Absence cannot identify a replacement owner. The captured old local
		// authority must still be fenced, while this post-auth change stays typed.
		causes[1] = errors.New("p2p.user_scope_mismatch")
	}
	if readErr != nil {
		causes[2] = readErr
	} else {
		causes[2] = account.host.deleteAccountSession(account.identity.ServiceID)
	}
	if manager != nil {
		completion, fenceErr := manager.FenceAccountForLogout()
		causes[3] = fenceErr
		if completion != nil {
			account.authRecoveryJoins = append(account.authRecoveryJoins, completion)
		}
	} else if client != nil {
		// No Manager owns registration/pins/gateways in this explicit phase.
		client.SetAccount("")
	}
	account.forgetToken()
	account.host.announceDirectory(account.identity.ServiceID, account.snapshot(account.identity.ServiceID).Revision)
	// Local cleanup never establishes recovery provenance or reports remote ACK.
	return account.logoutResult(result, causes)
}

type logoutBootstrapAdmission struct {
	serviceID  string
	session    persistedAccountSession
	owner      *bootstrapSessionOwner
	generation uint64
}

// Outside account.mu: an active fresh-pin job may itself need that lock. The
// session owner is revocation bookkeeping, never a cached authorization read.
func (host *Host) admitLogoutBootstrap(serviceID string, data json.RawMessage) (logoutBootstrapAdmission, error) {
	var request struct {
		Token string `json:"token"`
	}
	if protocol.DecodeExact(data, &request) != nil {
		return logoutBootstrapAdmission{}, errors.New("p2p.invalid_request")
	}
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	session, exists, err := host.readAccountSession(serviceID)
	if err != nil {
		return logoutBootstrapAdmission{}, err
	}
	if !exists {
		return logoutBootstrapAdmission{}, errors.New("p2p.user_login_required")
	}
	if request.Token != session.Token {
		return logoutBootstrapAdmission{}, errors.New("p2p.user_scope_mismatch")
	}
	generation := host.bootstrapGeneration[serviceID]
	owner := host.bootstrapSessionOwnerLocked(serviceID, session)
	return logoutBootstrapAdmission{serviceID: serviceID, session: session, owner: owner, generation: generation}, nil
}

func (host *Host) cancelLogoutBootstrap(admission logoutBootstrapAdmission) error {
	host.bootstrapMu.Lock()
	if host.bootstrapGeneration[admission.serviceID] != admission.generation {
		host.bootstrapMu.Unlock()
		return errors.New("p2p.user_scope_mismatch")
	}
	current, exists, err := host.readAccountSession(admission.serviceID)
	if err != nil || !exists || current != admission.session {
		host.bootstrapMu.Unlock()
		if err != nil {
			return err
		}
		return errors.New("p2p.user_scope_mismatch")
	}
	job := host.bootstraps[admission.serviceID]
	if admission.owner == nil || host.bootstrapSessionOwners[admission.serviceID] != admission.owner || !admission.owner.matches(admission.session) || job != nil && (job.sessionOwner != admission.owner || !job.hasSession || job.session != admission.session || job.generation != admission.generation) {
		host.bootstrapMu.Unlock()
		return errors.New("p2p.user_scope_mismatch")
	}
	// Only this exact session owner is revoked. Captured, unscheduled old jobs
	// retain this object too; a new session/generation keeps its independent owner.
	admission.owner.revoked = true
	if job != nil {
		job.cancel()
	}
	host.bootstrapMu.Unlock()
	if job != nil {
		<-job.done
	}
	return nil
}
