package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

type Lease struct {
	Version      int    `json:"version"`
	ServiceID    string `json:"serviceId"`
	UserID       string `json:"userId"`
	NetworkID    string `json:"networkId"`
	PairID       string `json:"pairId"`
	AttemptID    string `json:"attemptId"`
	FromDeviceID string `json:"fromDeviceId"`
	ToDeviceID   string `json:"toDeviceId"`
	Generation   uint64 `json:"generation"`
	Revision     uint64 `json:"revision"`
	ExpiresAt    int64  `json:"expiresAt"`
	Permission   string `json:"permission"`
	Signature    string `json:"signature"`
}

func (lease Lease) SigningBytes() []byte {
	encoded, _ := json.Marshal([]any{"dshker.lease.v1", lease.Version, lease.ServiceID, lease.UserID, lease.NetworkID, lease.PairID, lease.AttemptID, lease.FromDeviceID, lease.ToDeviceID, lease.Generation, lease.Revision, lease.ExpiresAt, lease.Permission})
	return encoded
}

func (lease Lease) Verify(public ed25519.PublicKey, scope SignalScope, userID, networkID string, revision uint64, now time.Time) error {
	if !ValidID(userID) || !ValidID(networkID) || lease.UserID != userID || lease.NetworkID != networkID {
		return errors.New("p2p.lease_scope_mismatch")
	}
	if lease.Version != Version || len(public) != ed25519.PublicKeySize || lease.ServiceID != KeyID(public) || lease.Permission != "dsh-session" || lease.Generation != scope.Generation || lease.Revision != revision || revision == 0 || lease.AttemptID != scope.AttemptID || lease.PairID != scope.PairID || lease.FromDeviceID != scope.FromDeviceID || lease.ToDeviceID != scope.ToDeviceID {
		return errors.New("p2p.lease_scope_mismatch")
	}
	if !ValidID(lease.AttemptID) || !ValidID(lease.PairID) || !ValidID(lease.FromDeviceID) || !ValidID(lease.ToDeviceID) || lease.FromDeviceID == lease.ToDeviceID {
		return errors.New("p2p.lease_scope_mismatch")
	}
	// The upper bound absorbs coordinator-granted lease TTLs (the deployed
	// server grants roughly 65s) while still rejecting far-future or forged
	// expiries beyond any plausible skew.
	if lease.ExpiresAt <= now.Unix() || lease.ExpiresAt > now.Add(2*time.Minute).Unix() {
		return errors.New("p2p.lease_expired")
	}
	signature, err := base64.RawURLEncoding.DecodeString(lease.Signature)
	if err != nil || !ed25519.Verify(public, lease.SigningBytes(), signature) {
		return errors.New("p2p.identity_mismatch")
	}
	return nil
}
