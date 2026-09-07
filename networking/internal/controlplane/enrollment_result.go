package controlplane

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strconv"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

type enrollmentQuery struct {
	RequestID string `json:"requestId"`
	PublicKey []byte `json:"publicKey"`
	IssuedAt  int64  `json:"issuedAt"`
	Signature string `json:"signature"`
}

func newEnrollmentQuery(requestID string, private ed25519.PrivateKey, now time.Time) (enrollmentQuery, error) {
	if !protocol.ValidID(requestID) || len(private) != ed25519.PrivateKeySize {
		return enrollmentQuery{}, errors.New("p2p.invalid_request")
	}
	// Do not accept a corrupted raw key whose public suffix no longer matches its seed.
	if !bytes.Equal(private, ed25519.NewKeyFromSeed(private.Seed())) {
		return enrollmentQuery{}, errors.New("p2p.identity_mismatch")
	}
	query := enrollmentQuery{RequestID: requestID, PublicKey: append([]byte(nil), private.Public().(ed25519.PublicKey)...), IssuedAt: now.Unix()}
	message := "dshker.enrollment-query.v1\n" + requestID + "\n" + base64.RawURLEncoding.EncodeToString(query.PublicKey) + "\n" + strconv.FormatInt(query.IssuedAt, 10)
	query.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(message)))
	return query, nil
}

// ReadEnrollment queries the original request with proof of the original key.
// It never consumes another token, re-enrolls, or transmits the private key.
func (client *Client) ReadEnrollment(ctx context.Context, requestID string, private ed25519.PrivateKey, authority Identity) (Device, error) {
	query, err := newEnrollmentQuery(requestID, private, time.Now())
	if err != nil {
		return Device{}, err
	}
	var result Device
	if err := client.call(ctx, "POST", "/v1/enrollment-query", "", query, &result); err != nil {
		return Device{}, err
	}
	verified, err := client.WithDevice(result, private, authority)
	if err != nil {
		return Device{}, err
	}
	verified.Close()
	return result, nil
}
