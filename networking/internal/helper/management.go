package helper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func (account *account) management(ctx context.Context, method string, data json.RawMessage) (any, error) {
	switch method {
	case "user.current", "user.logout", "devices.list", "networks.rename", "networks.limit", "networks.delete", "networks.devices", "networks.pairs", "devices.bind", "devices.unbind", "networks.deletePair":
		return account.userManagement(ctx, method, data)
	case "user.login":
		var request struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.Login(ctx, request.Username, request.Password)
	case "user.register":
		var request struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		// The coordinator's register endpoint returns the created user without a
		// session, so sign in with the same credentials to hand back a usable
		// one. A refused sign-in is reported as it came: the account already
		// exists, so calling it a registration failure would be untrue and would
		// invite a retry that can now only fail with p2p.user_conflict.
		if _, err := account.base.Register(ctx, request.Email, request.Password); err != nil {
			return nil, err
		}
		return account.base.Login(ctx, request.Email, request.Password)
	case "networks.list":
		var request struct {
			Token string `json:"token"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.Networks(ctx, request.Token)
	case "networks.create":
		var request struct {
			Token string `json:"token"`
			Name  string `json:"name"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.CreateNetwork(ctx, request.Token, request.Name)
	case "device.enrollmentToken":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.EnrollmentToken(ctx, request.Token, request.NetworkID)
	case "device.enroll":
		var request controlplane.Enrollment
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.Enroll(ctx, request)
	case "device.enrollmentResult":
		var request struct {
			RequestID  string `json:"requestId"`
			PrivateKey []byte `json:"privateKey"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.ReadEnrollment(ctx, request.RequestID, request.PrivateKey, account.identity)
	}
	if account.client == nil {
		return nil, errors.New("p2p.device_unregistered")
	}
	switch method {
	case "pairs.list":
		var empty struct{}
		if protocol.Decode(data, &empty) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.client.Pairs(ctx)
	case "pairs.identity":
		var request struct {
			PairID string `json:"pairId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.client.PairIdentity(ctx, request.PairID)
	case "pairs.share":
		var request struct {
			NetworkID string `json:"networkId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		share, err := account.client.Share(ctx, request.NetworkID)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(share)
		return struct {
			Code      string `json:"code"`
			ExpiresAt int64  `json:"expiresAt"`
		}{base64.RawURLEncoding.EncodeToString(encoded), share.ExpiresAt}, err
	case "pairs.invite":
		var request struct {
			Code      string `json:"code"`
			NetworkID string `json:"networkId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		if _, err := controlplane.VerifyShare(request.Code, account.identity, request.NetworkID, account.device.DeviceID, time.Now()); err != nil {
			return nil, err
		}
		return account.client.Invite(ctx, request.Code)
	case "pairs.action":
		var request struct {
			PairID      string `json:"pairId"`
			Action      string `json:"action"`
			Fingerprint string `json:"fingerprint"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.client.PairAction(ctx, request.PairID, request.Action, request.Fingerprint)
	case "pairs.pin":
		var pin controlplane.PairIdentity
		if protocol.Decode(data, &pin) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return struct{}{}, account.manager.Pin(pin)
	}
	return nil, errors.New("p2p.invalid_operation")
}
