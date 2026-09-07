package controlplane

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func NewDeviceKey() (ed25519.PrivateKey, string, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	csr, err := DeviceCSR(key)
	if err != nil {
		return nil, "", err
	}
	return key, csr, nil
}

// DeviceCSR preserves a previously persisted identity; it never generates a replacement key.
func DeviceCSR(key ed25519.PrivateKey) (string, error) {
	if len(key) != ed25519.PrivateKeySize {
		return "", errors.New("p2p.invalid_device_key")
	}
	if !bytes.Equal(key, ed25519.NewKeyFromSeed(key.Seed())) {
		return "", errors.New("p2p.identity_mismatch")
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr})), nil
}

func (client *Client) Login(ctx context.Context, username, password string) (UserSession, error) {
	var result UserSession
	err := client.call(ctx, "POST", "/v1/login", "", struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}{username, password}, &result)
	if err == nil && (!protocol.ValidID(result.User.UserID) || len(result.Token) != 64 || result.ExpiresAt <= time.Now().Unix()) {
		err = errors.New("p2p.invalid_server_response")
	}
	return result, err
}

func (client *Client) Networks(ctx context.Context, token string) ([]Network, error) {
	var result []Network
	if token == "" {
		return nil, errors.New("p2p.user_unauthorized")
	}
	err := client.call(ctx, "GET", "/v1/networks", token, nil, &result)
	return result, err
}

func (client *Client) CreateNetwork(ctx context.Context, token, name string) (Network, error) {
	var result Network
	if token == "" {
		return result, errors.New("p2p.user_unauthorized")
	}
	err := client.call(ctx, "POST", "/v1/networks", token, struct {
		Name string `json:"name"`
	}{name}, &result)
	return result, err
}

func (client *Client) EnrollmentToken(ctx context.Context, token, networkID string) (EnrollmentGrant, error) {
	var result EnrollmentGrant
	if token == "" || !protocol.ValidID(networkID) {
		return result, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "POST", "/v1/networks/"+networkID+"/enrollment-tokens", token, struct{}{}, &result)
	return result, err
}

func (client *Client) Enroll(ctx context.Context, request Enrollment) (Device, error) {
	var result Device
	err := client.call(ctx, "POST", "/v1/enroll", "", request, &result)
	return result, err
}

func (client *Client) Pairs(ctx context.Context) ([]Pair, error) {
	var result []Pair
	err := client.call(ctx, "GET", "/v1/pairs", "", nil, &result)
	return result, err
}

func (client *Client) PairIdentity(ctx context.Context, pairID string) (PairIdentity, error) {
	var result PairIdentity
	if !protocol.ValidID(pairID) {
		return result, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "GET", "/v1/pairs/"+pairID+"/identity", "", nil, &result)
	if err == nil && (result.Pair.PairID != pairID || !protocol.ValidID(result.Pair.NetworkID) || result.Pair.Revision == 0 || !validPairDevice(result.Initiator) || !validPairDevice(result.Target) || result.Initiator.DeviceID != result.Pair.Initiator || result.Target.DeviceID != result.Pair.Target || result.Initiator.DeviceID == result.Target.DeviceID || result.Initiator.UserID != result.Target.UserID || ed25519.PublicKey(result.Initiator.PublicKey).Equal(ed25519.PublicKey(result.Target.PublicKey)) || (client.deviceID != result.Initiator.DeviceID && client.deviceID != result.Target.DeviceID) || (result.Pair.State != "active" && result.Pair.State != "invited" && result.Pair.State != "approved")) {
		err = errors.New("p2p.identity_mismatch")
	}
	return result, err
}

func validPairDevice(device PairDeviceIdentity) bool {
	return protocol.ValidID(device.DeviceID) && protocol.ValidID(device.UserID) && len(device.PublicKey) == ed25519.PublicKeySize && device.Name != "" && (device.Presence == "online" || device.Presence == "offline" || device.Presence == "stale")
}

func (client *Client) Share(ctx context.Context, networkID string) (Share, error) {
	var result Share
	if !protocol.ValidID(networkID) {
		return result, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "POST", "/v1/share", "", struct {
		NetworkID string `json:"networkId"`
	}{networkID}, &result)
	return result, err
}

func VerifyShare(encoded string, identity Identity, networkID, ownDeviceID string, now time.Time) (Share, error) {
	var share Share
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || protocol.Decode(data, &share) != nil {
		return Share{}, errors.New("p2p.invalid_pairing_code")
	}
	if share.Version != 1 || share.ServiceID != identity.ServiceID || share.NetworkID != networkID || !protocol.ValidID(share.DeviceID) || share.DeviceID == ownDeviceID || !protocol.ValidID(share.Nonce) || share.ExpiresAt <= now.Unix() || share.ExpiresAt > now.Add(5*time.Minute).Unix() {
		return Share{}, errors.New("p2p.invalid_pairing_code")
	}
	bytes, err := json.Marshal([]any{"dshker.pair-share.v1", share.Version, share.ServiceID, share.NetworkID, share.DeviceID, share.Fingerprint, share.Nonce, share.ExpiresAt})
	signature, decodeErr := base64.RawURLEncoding.DecodeString(share.Signature)
	if err != nil || decodeErr != nil || len(identity.PublicKey) != ed25519.PublicKeySize || !ed25519.Verify(identity.PublicKey, bytes, signature) {
		return Share{}, errors.New("p2p.invalid_pairing_code")
	}
	return share, nil
}

func (client *Client) Invite(ctx context.Context, shareCode string) (Pair, error) {
	var result Pair
	err := client.call(ctx, "POST", "/v1/invite", "", struct {
		Share string `json:"share"`
	}{shareCode}, &result)
	return result, err
}

func (client *Client) PairAction(ctx context.Context, pairID, action, fingerprint string) (Pair, error) {
	var result Pair
	if !protocol.ValidID(pairID) {
		return result, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "POST", "/v1/pair-action", "", struct {
		PairID      string `json:"pairId"`
		Action      string `json:"action"`
		Fingerprint string `json:"fingerprint"`
	}{pairID, action, fingerprint}, &result)
	return result, err
}

func (client *Client) Begin(ctx context.Context, pairID string, generation uint64) (Lease, error) {
	var result Lease
	err := client.call(ctx, "POST", "/v1/attempt", "", struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}{pairID, generation}, &result)
	return result, err
}

func (client *Client) RenewLease(ctx context.Context, pairID, attemptID string) (Lease, error) {
	var result Lease
	err := client.call(ctx, "POST", "/v1/lease", "", struct {
		PairID    string `json:"pairId"`
		AttemptID string `json:"attemptId"`
	}{pairID, attemptID}, &result)
	return result, err
}

func (client *Client) End(ctx context.Context, pairID, attemptID string) error {
	var result struct {
		AttemptID string `json:"attemptId"`
		Ended     bool   `json:"ended"`
	}
	err := client.call(ctx, "POST", "/v1/end", "", struct {
		PairID    string `json:"pairId"`
		AttemptID string `json:"attemptId"`
	}{pairID, attemptID}, &result)
	if err == nil && (result.AttemptID != attemptID || !result.Ended) {
		return errors.New("p2p.invalid_server_response")
	}
	return err
}
