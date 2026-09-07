package controlplane

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEnrollmentQueryProof(t *testing.T) {
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	requestID := strings.Repeat("a", 32)
	query, err := newEnrollmentQuery(requestID, private, time.Unix(1800000000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if query.RequestID != requestID || query.IssuedAt != 1800000000 || !bytes.Equal(query.PublicKey, private.Public().(ed25519.PublicKey)) {
		t.Fatal("query identity mismatch")
	}
	message := "dshker.enrollment-query.v1\n" + requestID + "\n" + base64.RawURLEncoding.EncodeToString(query.PublicKey) + "\n1800000000"
	signature, err := base64.RawURLEncoding.DecodeString(query.Signature)
	if err != nil || !ed25519.Verify(query.PublicKey, []byte(message), signature) {
		t.Fatal("invalid enrollment proof")
	}
	encoded, err := json.Marshal(query)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(base64.StdEncoding.EncodeToString(private))) || bytes.Contains(encoded, []byte("privateKey")) || bytes.Contains(encoded, []byte("token")) {
		t.Fatal("query exposes enrollment secrets")
	}
	query.PublicKey[0] ^= 1
	if !bytes.Equal(private, ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))) {
		t.Fatal("query aliases private key")
	}
}

func TestEnrollmentQueryRejectsInvalidIdentity(t *testing.T) {
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	corrupted := append(ed25519.PrivateKey(nil), private...)
	corrupted[63] ^= 1
	for _, test := range []struct {
		name, requestID string
		key             ed25519.PrivateKey
	}{
		{"missing-request", "", private},
		{"invalid-request", strings.Repeat("g", 32), private},
		{"missing-key", strings.Repeat("a", 32), nil},
		{"seed-not-key", strings.Repeat("a", 32), private[:32]},
		{"corrupt-key", strings.Repeat("a", 32), corrupted},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := newEnrollmentQuery(test.requestID, test.key, time.Now()); err == nil {
				t.Fatal("invalid identity accepted")
			}
		})
	}
}
