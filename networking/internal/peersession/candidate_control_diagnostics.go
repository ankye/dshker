package peersession

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// candidateControlDiagnostic contains only bounded identity and classification
// fields. It cannot retain a ticket, signal, error, subscription or session.
type candidateControlDiagnostic struct {
	At                        time.Time `json:"at"`
	Event                     string    `json:"event"`
	Disposition               string    `json:"disposition"`
	Code                      string    `json:"code"`
	ServiceID                 string    `json:"serviceId"`
	SubscriptionID            string    `json:"subscriptionId"`
	ServerEpoch               string    `json:"serverEpoch"`
	RegistrationCoreID        string    `json:"registrationCoreInstanceId"`
	RegistrationKnown         bool      `json:"registrationKnown"`
	CurrentSubscription       bool      `json:"currentSubscription"`
	CoreInstanceID            string    `json:"coreInstanceId"`
	AccountUserID             string    `json:"accountUserId"`
	TicketUserID              string    `json:"ticketUserId"`
	TicketServerEpoch         string    `json:"ticketServerEpoch"`
	TicketLocalCoreID         string    `json:"ticketLocalCoreInstanceId"`
	NetworkID                 string    `json:"networkId"`
	Direction                 string    `json:"direction"`
	RemoteDeviceID            string    `json:"remoteDeviceId"`
	PairKnown                 bool      `json:"pairKnown"`
	PairID                    string    `json:"pairId"`
	TicketPairID              string    `json:"ticketPairId"`
	AttemptID                 string    `json:"attemptId"`
	Generation                uint64    `json:"generation"`
	ActualOwnerSlot           string    `json:"actualOwnerSlot"`
	ActualOwnerAttemptID      string    `json:"actualOwnerAttemptId"`
	ActualOwnerGeneration     uint64    `json:"actualOwnerGeneration"`
	QueuedAdmissionAttemptID  string    `json:"queuedAdmissionAttemptId"`
	QueuedAdmissionGeneration uint64    `json:"queuedAdmissionGeneration"`
}

// captureCandidateControlDiagnosticLocked must share the admission's manager.mu
// barrier. The caller supplies the fence/current result it already read outside
// that lock. It takes no other lock and calls no Signals, client or network code.
// Write the returned value only after releasing manager.mu.
func (manager *Manager) captureCandidateControlDiagnosticLocked(event, disposition string, cause error, ticket protocol.CandidateTicket, fence protocol.RegistrationFence, currentSubscription bool) (candidateControlDiagnostic, bool) {
	lease := ticket.Lease
	record := candidateControlDiagnostic{
		At: time.Now().UTC(), Event: event, Disposition: disposition, Code: candidateControlDiagnosticCode(cause),
		ServiceID: manager.config.Authority.ServiceID, SubscriptionID: fence.SubscriptionID, ServerEpoch: fence.ServerEpoch,
		RegistrationCoreID:  fence.CoreInstanceID,
		RegistrationKnown:   fence.ServerEpoch != "" || fence.SubscriptionID != "" || fence.CoreInstanceID != "",
		CurrentSubscription: currentSubscription, CoreInstanceID: manager.config.CoreInstanceID, AccountUserID: manager.accountUserID,
		TicketUserID: lease.UserID, TicketServerEpoch: ticket.ServerEpoch, NetworkID: lease.NetworkID,
		TicketPairID: lease.PairID, AttemptID: lease.AttemptID, Generation: lease.Generation,
		Direction: "unrelated", ActualOwnerSlot: "absent",
	}
	local := manager.config.Device.DeviceID
	if !protocol.ValidID(local) || !protocol.ValidID(lease.FromDeviceID) || !protocol.ValidID(lease.ToDeviceID) {
		return candidateControlDiagnostic{}, false
	}
	switch {
	case lease.FromDeviceID == local && lease.ToDeviceID != local:
		record.Direction, record.RemoteDeviceID, record.TicketLocalCoreID = "initiated", lease.ToDeviceID, ticket.FromCoreInstanceID
	case lease.ToDeviceID == local && lease.FromDeviceID != local:
		record.Direction, record.RemoteDeviceID, record.TicketLocalCoreID = "answered", lease.FromDeviceID, ticket.ToCoreInstanceID
	}
	var candidate, primary, queued *session
	if record.RemoteDeviceID != "" {
		record.PairID, record.PairKnown = manager.pairForRemoteLocked(record.RemoteDeviceID, lease.NetworkID)
	}
	if record.PairKnown && record.Direction == "initiated" {
		candidate, primary = manager.candidates[record.PairID], manager.sessions[record.PairID]
	} else if record.PairKnown && record.Direction == "answered" {
		candidate, primary = manager.inboundCandidates[record.PairID], manager.inbound[record.PairID]
		if admission := manager.inboundAdmissions[record.PairID]; admission != nil {
			queued = admission.connection
			if queued == nil {
				return candidateControlDiagnostic{}, false
			}
			record.QueuedAdmissionAttemptID, record.QueuedAdmissionGeneration = candidateControlOwnerIdentity(queued)
		}
	}
	if candidate != nil {
		record.ActualOwnerSlot = "candidate"
		record.ActualOwnerAttemptID, record.ActualOwnerGeneration = candidateControlOwnerIdentity(candidate)
	} else if queued != nil {
		record.ActualOwnerSlot = "admission"
		record.ActualOwnerAttemptID, record.ActualOwnerGeneration = candidateControlOwnerIdentity(queued)
	} else if primary != nil {
		record.ActualOwnerSlot = "primary"
		record.ActualOwnerAttemptID, record.ActualOwnerGeneration = candidateControlOwnerIdentity(primary)
	}
	if !validCandidateControlDiagnostic(record) {
		return candidateControlDiagnostic{}, false
	}
	return record, true
}

// The caller passes the exact phase/dispatch fence it already obtained. In
// particular, completion logging must not resample a replacement subscription.
func (manager *Manager) captureCandidateControlDiagnostic(event, disposition string, cause error, ticket protocol.CandidateTicket, fence protocol.RegistrationFence, currentSubscription bool) (candidateControlDiagnostic, bool) {
	manager.mu.Lock()
	record, ok := manager.captureCandidateControlDiagnosticLocked(event, disposition, cause, ticket, fence, currentSubscription)
	manager.mu.Unlock()
	return record, ok
}

// candidateControlResult keeps the captured dispatch scope/owner by value. A
// "sent" record reports only that socket send's result, never a peer ACK.
func candidateControlResult(record candidateControlDiagnostic, disposition string, cause error) (candidateControlDiagnostic, bool) {
	if !validCandidateControlDiagnostic(record) {
		return candidateControlDiagnostic{}, false
	}
	record.At, record.Disposition, record.Code = time.Now().UTC(), disposition, candidateControlDiagnosticCode(cause)
	if !validCandidateControlDiagnostic(record) {
		return candidateControlDiagnostic{}, false
	}
	return record, true
}

// A reserved outbound operation has an immutable prepare identity before the
// ticket is installed. An admitted candidate/primary uses its installed lease.
func candidateControlOwnerIdentity(connection *session) (string, uint64) {
	if connection.ticket == nil && connection.prepare != nil {
		return connection.prepare.AttemptID, connection.prepare.Generation
	}
	return connection.lease.AttemptID, connection.lease.Generation
}

func candidateControlDiagnosticCode(cause error) string {
	if cause == nil {
		return "none"
	}
	if errors.Is(cause, context.Canceled) {
		return "context.canceled"
	}
	if errors.Is(cause, context.DeadlineExceeded) {
		return "context.deadline_exceeded"
	}
	code, _ := protocol.Refusal(cause)
	switch code {
	case "p2p.invalid_payload", "p2p.invalid_request", "p2p.candidate_scope_mismatch", "p2p.candidate_unsupported",
		"p2p.connection_busy", "p2p.connection_cancelled", "p2p.candidate_cancelled",
		"p2p.registration_stale", "p2p.subscription_superseded", "p2p.signal_superseded", "p2p.signalling_not_ready",
		"p2p.core_replaced", "p2p.account_changed", "p2p.active_changed", "p2p.stale_generation", "p2p.lease_expired",
		"p2p.identity_mismatch", "p2p.lease_scope_mismatch", "p2p.signal_scope_mismatch", "p2p.protocol_mismatch",
		"p2p.candidate_conflict", "p2p.attempt_not_found", "p2p.pair_unauthorized", "p2p.user_unauthorized",
		"p2p.network_unauthorized", "p2p.binding_unauthorized", "p2p.pair_revoked", "p2p.helper_unavailable",
		"p2p.signal_limit", "p2p.rate_limited", "p2p.network_revoked", "p2p.invalid_server_response":
		return code
	default:
		return "unknown"
	}
}

func validCandidateControlDiagnostic(record candidateControlDiagnostic) bool {
	if record.At.IsZero() || record.At.Location() != time.UTC || !candidateControlEvent(record.Event) || !candidateControlDisposition(record.Disposition) {
		return false
	}
	for _, id := range []string{record.ServiceID, record.TicketUserID, record.NetworkID, record.TicketPairID} {
		if !protocol.ValidID(id) {
			return false
		}
	}
	if record.AccountUserID != "" && !protocol.ValidID(record.AccountUserID) {
		return false
	}
	for _, nonce := range []string{record.CoreInstanceID, record.TicketServerEpoch, record.AttemptID} {
		if !protocol.ValidNonce(nonce) {
			return false
		}
	}
	if !protocol.ValidGeneration(record.Generation) || !candidateControlOptionalFence(record) {
		return false
	}
	if record.Code != "none" && record.Code != "unknown" && record.Code != "context.canceled" && record.Code != "context.deadline_exceeded" && candidateControlDiagnosticCode(errors.New(record.Code)) != record.Code {
		return false
	}
	if record.Direction != "initiated" && record.Direction != "answered" && record.Direction != "unrelated" {
		return false
	}
	if record.Direction != "unrelated" && !protocol.ValidNonce(record.TicketLocalCoreID) || record.Direction == "unrelated" && record.TicketLocalCoreID != "" {
		return false
	}
	if record.Direction != "unrelated" && !protocol.ValidID(record.RemoteDeviceID) || record.Direction == "unrelated" && record.RemoteDeviceID != "" {
		return false
	}
	if record.PairKnown && !protocol.ValidID(record.PairID) || !record.PairKnown && record.PairID != "" {
		return false
	}
	if record.QueuedAdmissionAttemptID == "" && record.QueuedAdmissionGeneration != 0 || record.QueuedAdmissionAttemptID != "" &&
		(!record.PairKnown || !protocol.ValidNonce(record.QueuedAdmissionAttemptID) || !protocol.ValidGeneration(record.QueuedAdmissionGeneration)) {
		return false
	}
	if record.ActualOwnerSlot == "absent" {
		return record.ActualOwnerAttemptID == "" && record.ActualOwnerGeneration == 0
	}
	return record.PairKnown && (record.ActualOwnerSlot == "candidate" || record.ActualOwnerSlot == "primary" || record.ActualOwnerSlot == "admission") && protocol.ValidNonce(record.ActualOwnerAttemptID) && protocol.ValidGeneration(record.ActualOwnerGeneration)
}

func candidateControlOptionalFence(record candidateControlDiagnostic) bool {
	if !record.RegistrationKnown {
		return record.SubscriptionID == "" && record.ServerEpoch == "" && record.RegistrationCoreID == ""
	}
	return protocol.ValidNonce(record.SubscriptionID) && protocol.ValidNonce(record.ServerEpoch) && protocol.ValidNonce(record.RegistrationCoreID)
}

func candidateControlEvent(event string) bool {
	switch event {
	case "prepared", "signal", "decision", "offer", "answer":
		return true
	default:
		return false
	}
}

func candidateControlDisposition(disposition string) bool {
	switch disposition {
	case "accepted", "refused", "queued", "no_owner", "canceled", "retired", "stale_fence", "started", "gathered", "sent", "failed", "applied":
		return true
	default:
		return false
	}
}

func marshalCandidateControlDiagnostic(record candidateControlDiagnostic) ([]byte, bool) {
	if !validCandidateControlDiagnostic(record) {
		return nil, false
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return nil, false
	}
	return append(append([]byte("candidate.control "), encoded...), '\n'), true
}

// One stderr write preserves a single credential-free line. A diagnostic failure
// never changes admission, starts network work or writes an unclassified error.
func writeCandidateControlDiagnostic(record candidateControlDiagnostic) bool {
	encoded, ok := marshalCandidateControlDiagnostic(record)
	if !ok {
		return false
	}
	_, err := os.Stderr.Write(encoded)
	return err == nil
}
