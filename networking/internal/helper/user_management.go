package helper

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func (account *account) userManagement(ctx context.Context, method string, data json.RawMessage) (any, error) {
	switch method {
	case "user.current", "user.logout", "devices.list":
		var request struct {
			Token string `json:"token"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		switch method {
		case "user.current":
			return account.base.CurrentUser(ctx, request.Token)
		case "user.logout":
			return struct{}{}, account.base.Logout(ctx, request.Token)
		default:
			return account.base.UserDevices(ctx, request.Token)
		}
	case "networks.rename":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			Name      string `json:"name"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.RenameNetwork(ctx, request.Token, request.NetworkID, request.Name)
	case "networks.limit":
		var request struct {
			Token      string `json:"token"`
			NetworkID  string `json:"networkId"`
			MaxDevices int    `json:"maxDevices"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return account.base.UpdateNetworkLimit(ctx, request.Token, request.NetworkID, request.MaxDevices)
	case "networks.delete", "networks.devices", "networks.pairs":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		switch method {
		case "networks.delete":
			return struct{}{}, account.base.DeleteNetwork(ctx, request.Token, request.NetworkID)
		case "networks.devices":
			return account.base.NetworkDevices(ctx, request.Token, request.NetworkID)
		default:
			return account.base.NetworkPairs(ctx, request.Token, request.NetworkID)
		}
	case "devices.bind", "devices.unbind":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			DeviceID  string `json:"deviceId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		if method == "devices.bind" {
			return struct{}{}, account.base.BindDevice(ctx, request.Token, request.NetworkID, request.DeviceID)
		}
		return struct{}{}, account.base.UnbindDevice(ctx, request.Token, request.NetworkID, request.DeviceID)
	case "networks.deletePair":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			PairID    string `json:"pairId"`
		}
		if protocol.Decode(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return struct{}{}, account.base.DeletePair(ctx, request.Token, request.NetworkID, request.PairID)
	}
	return nil, errors.New("p2p.invalid_operation")
}
