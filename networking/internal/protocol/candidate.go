package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"time"
)

func (ticket CandidateTicket) SigningBytes() []byte {
	lease := ticket.Lease
	values := []any{lease.Version, lease.ServiceID, lease.UserID, lease.NetworkID,
		lease.PairID, lease.AttemptID, lease.FromDeviceID, lease.ToDeviceID,
		lease.Generation, lease.Revision, lease.ExpiresAt, lease.Permission, lease.Signature}
	encoded, _ := json.Marshal([]any{"dshker.candidate.v1", ticket.Version, values,
		ticket.ServerEpoch, ticket.PreviousAttemptID, ticket.PreviousGeneration,
		ticket.FromCoreInstanceID, ticket.ToCoreInstanceID, ticket.PrepareDeadline})
	return encoded
}

func (ticket *CandidateTicket) Sign(key ed25519.PrivateKey) {
	ticket.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, ticket.SigningBytes()))
}

// Verify authenticates immutable bytes, including the original lease. Time
// permission belongs to the lifecycle operation, so old decisions remain readable.
func (ticket CandidateTicket) Verify(key ed25519.PublicKey) error {
	lease := ticket.Lease
	if ticket.Version != CandidateVersion || !ValidNonce(ticket.ServerEpoch) ||
		!ValidNonce(ticket.FromCoreInstanceID) || !ValidNonce(ticket.ToCoreInstanceID) ||
		!ValidNonce(lease.AttemptID) || !ValidID(lease.UserID) || !ValidID(lease.NetworkID) ||
		!ValidID(lease.PairID) || !ValidID(lease.FromDeviceID) || !ValidID(lease.ToDeviceID) ||
		lease.PairID != lease.ToDeviceID || lease.FromDeviceID == lease.ToDeviceID ||
		!ValidGeneration(lease.Generation) || !ValidGeneration(lease.Revision) ||
		lease.Version != Version || lease.Permission != "dsh-session" ||
		len(key) != ed25519.PublicKeySize || lease.ServiceID != KeyID(key) ||
		lease.ExpiresAt <= 0 || ticket.PrepareDeadline < lease.ExpiresAt ||
		ticket.PrepareDeadline-lease.ExpiresAt > int64(CandidateLifetime/time.Second) {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	if (ticket.PreviousAttemptID == "") != (ticket.PreviousGeneration == 0) ||
		(ticket.PreviousAttemptID != "" && (!ValidNonce(ticket.PreviousAttemptID) || !ValidGeneration(ticket.PreviousGeneration))) {
		return errors.New("p2p.candidate_scope_mismatch")
	}
	if !validSignature(key, lease.SigningBytes(), lease.Signature) || !validSignature(key, ticket.SigningBytes(), ticket.Signature) {
		return errors.New("p2p.identity_mismatch")
	}
	return nil
}

func validSignature(key ed25519.PublicKey, body []byte, encoded string) bool {
	signature, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(key) == ed25519.PublicKeySize && ed25519.Verify(key, body, signature)
}

func ValidGeneration(value uint64) bool { return value > 0 && value <= 1<<53-1 }

func (fence RegistrationFence) Valid() bool {
	return ValidNonce(fence.ServerEpoch) && ValidNonce(fence.SubscriptionID) && ValidNonce(fence.CoreInstanceID)
}

func ValidControlCapabilities(values []string) bool {
	return values != nil && ValidCapabilities(values)
}

// DecodeControl also requires nested struct fields with their exact JSON names.
func DecodeControl(data []byte, target any) error {
	if err := DecodeExact(data, target); err != nil {
		return err
	}
	return requiredControlFields(data, reflect.TypeOf(target).Elem())
}

func requiredControlFields(data []byte, kind reflect.Type) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return errors.New("p2p.invalid_fields")
	}
	for index := 0; index < kind.NumField(); index++ {
		field := kind.Field(index)
		value, exists := fields[field.Tag.Get("json")]
		if !exists {
			return errors.New("p2p.missing_field")
		}
		if field.Type.Kind() == reflect.Struct {
			if err := requiredControlFields(value, field.Type); err != nil {
				return err
			}
		}
	}
	return nil
}

func (lease Lease) VerifyCandidate(key ed25519.PublicKey, ticket CandidateTicket, now time.Time) error {
	if err := lease.VerifyCandidateScope(key, ticket); err != nil {
		return err
	}
	if lease.ExpiresAt <= now.Unix() || lease.ExpiresAt > now.Add(2*time.Minute).Unix() {
		return errors.New("p2p.lease_expired")
	}
	return nil
}

// VerifyCandidateScope authenticates historical state without granting current
// time permission. Readback of a terminal decision must not revive its lease.
func (lease Lease) VerifyCandidateScope(key ed25519.PublicKey, ticket CandidateTicket) error {
	if err := ticket.Verify(key); err != nil {
		return err
	}
	original := ticket.Lease
	if lease.Version != original.Version || lease.ServiceID != original.ServiceID ||
		lease.UserID != original.UserID || lease.NetworkID != original.NetworkID ||
		lease.PairID != original.PairID || lease.AttemptID != original.AttemptID ||
		lease.FromDeviceID != original.FromDeviceID || lease.ToDeviceID != original.ToDeviceID ||
		lease.Generation != original.Generation || lease.Revision != original.Revision || lease.Permission != original.Permission {
		return errors.New("p2p.lease_scope_mismatch")
	}
	if !validSignature(key, lease.SigningBytes(), lease.Signature) {
		return errors.New("p2p.identity_mismatch")
	}
	return nil
}

func (signal Signal) VerifyCandidate(key, serverKey ed25519.PublicKey, ticket CandidateTicket, scope SignalScope, now time.Time) error {
	if err := ticket.Verify(serverKey); err != nil {
		return err
	}
	lease := ticket.Lease
	if scope.AttemptID != lease.AttemptID || scope.PairID != lease.PairID || scope.Generation != lease.Generation ||
		!((scope.FromDeviceID == lease.FromDeviceID && scope.ToDeviceID == lease.ToDeviceID) ||
			(scope.FromDeviceID == lease.ToDeviceID && scope.ToDeviceID == lease.FromDeviceID)) {
		return errors.New("p2p.signal_scope_mismatch")
	}
	return signal.verify(key, scope, now, ValidNonce(signal.AttemptID))
}
