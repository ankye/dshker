package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

var identifier = regexp.MustCompile(`^[a-f0-9]{32}$`)

func NewID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err) // No identity is safe without OS entropy.
	}
	return hex.EncodeToString(value)
}

func ValidID(value string) bool { return identifier.MatchString(value) }

func KeyID(public ed25519.PublicKey) string {
	digest := sha256.Sum256(public)
	return hex.EncodeToString(digest[:])
}

type Signal struct {
	Version      int    `json:"version"`
	Type         string `json:"type"`
	MessageID    string `json:"messageId"`
	AttemptID    string `json:"attemptId"`
	Generation   uint64 `json:"generation"`
	FromDeviceID string `json:"fromDeviceId"`
	ToDeviceID   string `json:"toDeviceId"`
	PairID       string `json:"pairId"`
	Sequence     uint64 `json:"sequence"`
	ExpiresAt    int64  `json:"expiresAt"`
	Payload      string `json:"payload"`
	Signature    string `json:"signature"`
}

// Payload is base64url of a strict typed JSON body, never arbitrary binary data.
type SDP struct {
	SDP string `json:"sdp"`
}

type Candidate struct {
	SDPHash   string `json:"sdpHash"`
	Candidate string `json:"candidate"`
	MID       string `json:"mid"`
	Line      uint16 `json:"line"`
}

func (signal Signal) SigningBytes() []byte {
	// Fixed-order JSON array with domain separation; integers never exceed JS exact range.
	encoded, _ := json.Marshal([]any{"dshker.signal.v1", signal.Version, signal.Type,
		signal.MessageID, signal.AttemptID, signal.Generation, signal.FromDeviceID,
		signal.ToDeviceID, signal.PairID, signal.Sequence, signal.ExpiresAt, signal.Payload})
	return encoded
}

func (signal *Signal) Sign(key ed25519.PrivateKey) {
	signal.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, signal.SigningBytes()))
}

type SignalScope struct {
	AttemptID, FromDeviceID, ToDeviceID, PairID string
	Generation, NextSequence                    uint64
}

func (signal Signal) Verify(key ed25519.PublicKey, scope SignalScope, now time.Time) error {
	if signal.Version != Version || signal.Generation == 0 || signal.Generation > 1<<53-1 ||
		signal.Sequence == 0 || signal.Sequence > 1<<53-1 || !ValidID(signal.MessageID) {
		return errors.New("p2p.protocol_mismatch")
	}
	if !ValidID(signal.AttemptID) || !ValidID(signal.FromDeviceID) || !ValidID(signal.ToDeviceID) ||
		!ValidID(signal.PairID) || signal.FromDeviceID == signal.ToDeviceID ||
		signal.AttemptID != scope.AttemptID || signal.FromDeviceID != scope.FromDeviceID ||
		signal.ToDeviceID != scope.ToDeviceID || signal.PairID != scope.PairID ||
		signal.Generation != scope.Generation || signal.Sequence != scope.NextSequence {
		return errors.New("p2p.signal_scope_mismatch")
	}
	if signal.ExpiresAt <= now.Unix() || signal.ExpiresAt > now.Add(60*time.Second).Unix() {
		return errors.New("p2p.signal_expired")
	}
	if err := signal.validatePayload(); err != nil {
		return err
	}
	signature, err := base64.RawURLEncoding.DecodeString(signal.Signature)
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, signal.SigningBytes(), signature) {
		return errors.New("p2p.identity_mismatch")
	}
	return nil
}

func (signal Signal) validatePayload() error {
	if len(signal.Payload) > 48*1024 {
		return errors.New("p2p.protocol_limit")
	}
	body, err := base64.RawURLEncoding.DecodeString(signal.Payload)
	if err != nil {
		return errors.New("p2p.invalid_payload")
	}
	switch signal.Type {
	case "offer", "answer":
		var payload SDP
		if Decode(body, &payload) != nil || len(payload.SDP) == 0 || len(payload.SDP) > 32*1024 {
			return errors.New("p2p.invalid_sdp")
		}
	case "candidate", "end-of-candidates":
		var payload Candidate
		if Decode(body, &payload) != nil || len(payload.SDPHash) != 64 || len(payload.Candidate) > 2048 || len(payload.MID) > 64 {
			return errors.New("p2p.invalid_candidate")
		}
		if _, err := hex.DecodeString(payload.SDPHash); err != nil {
			return errors.New("p2p.invalid_candidate")
		}
		if (signal.Type == "candidate") != (payload.Candidate != "") {
			return errors.New("p2p.invalid_candidate")
		}
	default:
		return errors.New("p2p.protocol_mismatch")
	}
	return nil
}
