package helper

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type bootstrapJob struct {
	serviceID    string
	credential   storedCredential
	session      persistedAccountSession
	hasSession   bool
	sessionOwner *bootstrapSessionOwner
	generation   uint64
	removal      uint64
	ctx          context.Context
	cancel       context.CancelFunc
	done         chan struct{}
}

// One current object per service slot; captured jobs retain their own original
// object. No history/token-keyed cache grows across selected sessions.
// All fields are immutable except revoked, which is protected by bootstrapMu.
type bootstrapSessionOwner struct {
	tokenHash [32]byte
	expiresAt int64
	revoked   bool
}

func (owner *bootstrapSessionOwner) matches(session persistedAccountSession) bool {
	return owner.tokenHash == sha256.Sum256([]byte(session.Token)) && owner.expiresAt == session.ExpiresAt
}

func (host *Host) bootstrapSessionOwnerLocked(serviceID string, session persistedAccountSession) *bootstrapSessionOwner {
	if host.bootstrapSessionOwners == nil {
		host.bootstrapSessionOwners = make(map[string]*bootstrapSessionOwner)
	}
	owner := host.bootstrapSessionOwners[serviceID]
	if owner == nil || !owner.matches(session) {
		owner = &bootstrapSessionOwner{tokenHash: sha256.Sum256([]byte(session.Token)), expiresAt: session.ExpiresAt}
		host.bootstrapSessionOwners[serviceID] = owner
	}
	return owner
}

// Session revocation outlives a worker generation. This object is not fresh
// authorization; job and logout admissions retain their separate exact fences.
func (host *Host) checkSessionRevocation(serviceID string, session persistedAccountSession) error {
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	return host.checkSessionRevocationLocked(serviceID, session)
}

func (host *Host) checkSessionRevocationLocked(serviceID string, session persistedAccountSession) error {
	if owner := host.bootstrapSessionOwners[serviceID]; owner != nil && owner.matches(session) && owner.revoked {
		return errors.New("p2p.user_scope_mismatch")
	}
	return nil
}

// The two named readmission operations cannot turn a retained, locally revoked
// login into a new worker generation. Bad payload/token never cancels a job.
func (host *Host) admitSelectedSessionRead(serviceID, method string, data json.RawMessage) error {
	var token string
	switch method {
	case "user.current":
		var request struct {
			Token string `json:"token"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return errors.New("p2p.invalid_request")
		}
		token = request.Token
	case "device.restore":
		var request deviceRestoreRequest
		if protocol.DecodeExact(data, &request) != nil {
			return errors.New("p2p.invalid_device_state")
		}
		defer clear(request.PrivateKey)
		if request.Pins == nil || len(request.Pins) != 0 || request.AccountUserID != "" && !protocol.ValidID(request.AccountUserID) {
			return errors.New("p2p.invalid_request")
		}
	default:
		return errors.New("p2p.invalid_request")
	}
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	session, exists, err := host.readAccountSession(serviceID)
	if err != nil {
		return err
	}
	if method == "user.current" {
		if !exists {
			return errors.New("p2p.user_login_required")
		}
		if token != session.Token {
			return errors.New("p2p.user_scope_mismatch")
		}
	}
	if !exists {
		return nil
	} // Explicitly signed out device restore, not an inferred login.
	return host.checkSessionRevocationLocked(serviceID, session)
}

type bootstrapGuardKey struct{}

func (host *Host) bootstrapSourceContext(ctx context.Context, job *bootstrapJob, requireOwner bool) context.Context {
	ctx = withBootstrapLocalFence(ctx, job.serviceID, job.generation, job, requireOwner)
	prior, _ := ctx.Value(bootstrapGuardKey{}).(func() error)
	return context.WithValue(ctx, bootstrapGuardKey{}, func() error {
		if prior != nil {
			if err := prior(); err != nil {
				return err
			}
		}
		return host.checkBootstrapSource(job, requireOwner)
	})
}

func bootstrapTransient(err error) bool {
	if err == nil {
		return false
	}
	switch err.Error() {
	case "p2p.rate_limited", "p2p.server_unavailable", "p2p.signalling_not_ready", "p2p.registration_stale":
		return true
	default:
		return bootstrapTransient(errors.Unwrap(err))
	}
}

// Call only outside account.mu. The cancelled worker may be waiting for it.
func (host *Host) cancelBootstraps(serviceID string) {
	host.bootstrapMu.Lock()
	if host.bootstrapGeneration == nil {
		host.bootstrapGeneration = make(map[string]uint64)
	}
	var jobs []*bootstrapJob
	if serviceID != "" {
		host.bootstrapGeneration[serviceID]++
	}
	for id, job := range host.bootstraps {
		if serviceID == "" || id == serviceID {
			if serviceID == "" {
				host.bootstrapGeneration[id]++
			}
			job.cancel()
			jobs = append(jobs, job)
		}
	}
	host.bootstrapMu.Unlock()
	for _, job := range jobs {
		<-job.done
	}
}

func (host *Host) bootstrapServiceFence(serviceID string) (uint64, error) {
	host.mu.Lock()
	closed, store, removal := host.closed, host.catalog, host.removedAt[serviceID]
	configured := host.accounts[serviceID] != nil
	host.mu.Unlock()
	if closed {
		return 0, errors.New("p2p.helper_unavailable")
	}
	if removal != 0 && !configured {
		return 0, errors.New("p2p.service_unconfigured")
	}
	if store == nil {
		return 0, errors.New("p2p.catalog_unavailable")
	}
	snapshot, err := store.Inspect()
	if err != nil {
		return 0, err
	}
	if snapshot == nil {
		return 0, errors.New("p2p.not_enabled")
	}
	for _, id := range snapshot.Record.ForgottenServiceIDs {
		if id == serviceID {
			return 0, errors.New("p2p.service_unconfigured")
		}
	}
	for _, service := range snapshot.Record.Services {
		if service.ServiceID == serviceID {
			return removal, nil
		}
	}
	return 0, errors.New("p2p.service_unconfigured")
}

func (host *Host) captureBootstrap(serviceID string) (*bootstrapJob, error) {
	removal, err := host.bootstrapServiceFence(serviceID)
	if err != nil {
		return nil, err
	}
	credential, err := host.LoadCredential(serviceID)
	if err != nil {
		return nil, err
	}
	host.bootstrapMu.Lock()
	session, exists, err := host.readAccountSession(serviceID)
	if err != nil {
		host.bootstrapMu.Unlock()
		clear(credential.PrivateKey)
		return nil, err
	}
	generation := host.bootstrapGeneration[serviceID]
	var owner *bootstrapSessionOwner
	if exists {
		owner = host.bootstrapSessionOwnerLocked(serviceID, session)
	}
	host.bootstrapMu.Unlock()
	return &bootstrapJob{serviceID: serviceID, credential: credential, session: session, hasSession: exists, sessionOwner: owner, generation: generation, removal: removal}, nil
}

func (host *Host) scheduleCapturedBootstrap(job *bootstrapJob) {
	serviceID := job.serviceID
	host.bootstrapMu.Lock()
	if host.bootstraps == nil {
		host.bootstraps = make(map[string]*bootstrapJob)
	}
	if host.bootstraps[serviceID] != nil || host.ctx.Err() != nil || host.bootstrapGeneration[serviceID] != job.generation || job.sessionOwner != nil && job.sessionOwner.revoked {
		host.bootstrapMu.Unlock()
		clear(job.credential.PrivateKey)
		return
	}
	ctx, cancel := context.WithCancel(host.ctx)
	job.ctx, job.cancel, job.done = ctx, cancel, make(chan struct{})
	host.bootstraps[serviceID] = job
	host.bootstrapMu.Unlock()
	go host.runBootstrap(job)
}

func sameBootstrapDevice(left, right storedCredential) bool {
	return left.ServiceID == right.ServiceID && left.Endpoints == right.Endpoints && left.DeviceID == right.DeviceID &&
		bytes.Equal(left.ServiceKey, right.ServiceKey) && bytes.Equal(left.PublicKey, right.PublicKey) && bytes.Equal(left.PrivateKey, right.PrivateKey)
}

func (host *Host) checkBootstrap(job *bootstrapJob) error {
	return host.checkBootstrapSource(job, true)
}

func (host *Host) checkBootstrapSource(job *bootstrapJob, requireOwner bool) error {
	if job.ctx != nil && job.ctx.Err() != nil {
		return errors.New("p2p.request_cancelled")
	}
	host.bootstrapMu.Lock()
	current := host.bootstrapGeneration[job.serviceID] == job.generation && (!requireOwner || host.bootstraps[job.serviceID] == job) && (job.sessionOwner == nil || !job.sessionOwner.revoked)
	host.bootstrapMu.Unlock()
	if !current {
		return errors.New("p2p.user_scope_mismatch")
	}
	removal, err := host.bootstrapServiceFence(job.serviceID)
	if err != nil {
		return err
	}
	if removal != job.removal {
		return errors.New("p2p.service_unconfigured")
	}
	credential, err := host.LoadCredential(job.serviceID)
	if err != nil {
		return err
	}
	defer clear(credential.PrivateKey)
	if !sameBootstrapDevice(job.credential, credential) {
		return errors.New("p2p.identity_mismatch")
	}
	session, exists, err := host.readAccountSession(job.serviceID)
	if err != nil {
		return err
	}
	if exists != job.hasSession || session != job.session {
		return errors.New("p2p.user_scope_mismatch")
	}
	return nil
}

func checkBootstrapContext(ctx context.Context) error {
	guard, ok := ctx.Value(bootstrapGuardKey{}).(func() error)
	if ok {
		return guard()
	}
	return nil
}

func (host *Host) runBootstrap(job *bootstrapJob) {
	defer func() {
		job.cancel()
		clear(job.credential.PrivateKey)
		host.bootstrapMu.Lock()
		if host.bootstraps[job.serviceID] == job {
			delete(host.bootstraps, job.serviceID)
		}
		host.bootstrapMu.Unlock()
		close(job.done)
	}()
	ctx := host.bootstrapSourceContext(job.ctx, job, true)
	for attempt := 0; ; attempt++ {
		index := attempt
		if index >= len(autoconnect.Backoff) {
			index = len(autoconnect.Backoff) - 1
		}
		timer := time.NewTimer(autoconnect.Backoff[index])
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if err := host.checkBootstrap(job); err != nil {
			return
		}
		credential, err := host.LoadCredential(job.serviceID)
		if err != nil {
			return
		}
		err = host.restoreStoredCredential(ctx, credential)
		clear(credential.PrivateKey)
		if err == nil {
			err = host.checkBootstrap(job)
		}
		if err == nil {
			intents, readErr := host.authorizedPairs()
			if readErr != nil {
				return
			}
			for _, intent := range intents {
				if intent.ServiceID == job.serviceID {
					host.AutoConnectEngine().Wake(intent)
				}
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
		log.Printf("[p2p] credential bootstrap for service %s refused: %s", job.serviceID, err.Error())
		if !bootstrapTransient(err) {
			return
		}
	}
}
