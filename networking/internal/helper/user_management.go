package helper

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func (account *account) userManagement(ctx context.Context, method string, data json.RawMessage) (any, error) {
	// Named auth owners admit real expired-device authentication independently
	// from activation, while valid original identities retain device attribution.
	if method == "user.current" || method == "user.logout" {
		var request struct {
			Token string `json:"token"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		client, err := account.authenticationClientLocked(ctx)
		if err != nil {
			return nil, err
		}
		if method == "user.current" {
			return client.CurrentUser(ctx, request.Token)
		}
		return struct{}{}, client.Logout(ctx, request.Token)
	}
	client, err := account.bearerClientLocked()
	if err != nil {
		return nil, err
	}
	switch method {
	case "devices.list":
		var request struct {
			Token string `json:"token"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return client.UserDevices(ctx, request.Token)
	case "networks.rename":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			Name      string `json:"name"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return client.RenameNetwork(ctx, request.Token, request.NetworkID, request.Name)
	case "networks.limit":
		var request struct {
			Token      string `json:"token"`
			NetworkID  string `json:"networkId"`
			MaxDevices int    `json:"maxDevices"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return client.UpdateNetworkLimit(ctx, request.Token, request.NetworkID, request.MaxDevices)
	case "networks.delete", "networks.devices", "networks.pairs":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		switch method {
		case "networks.delete":
			return struct{}{}, client.DeleteNetwork(ctx, request.Token, request.NetworkID)
		case "networks.devices":
			return client.NetworkDevices(ctx, request.Token, request.NetworkID)
		default:
			return client.NetworkPairs(ctx, request.Token, request.NetworkID)
		}
	case "network.leave":
		// Leaving needs the owner's session: the coordinator has no login-free
		// removal, and without one any holder of a deviceId could evict a device.
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			DeviceID  string `json:"deviceId"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return struct{}{}, client.UnbindDevice(ctx, request.Token, request.NetworkID, request.DeviceID)
	case "devices.bind", "devices.unbind":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			DeviceID  string `json:"deviceId"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		if method == "devices.bind" {
			return struct{}{}, client.BindDevice(ctx, request.Token, request.NetworkID, request.DeviceID)
		}
		return struct{}{}, client.UnbindDevice(ctx, request.Token, request.NetworkID, request.DeviceID)
	case "networks.deletePair":
		var request struct {
			Token     string `json:"token"`
			NetworkID string `json:"networkId"`
			PairID    string `json:"pairId"`
		}
		if protocol.DecodeExact(data, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		return struct{}{}, client.DeletePair(ctx, request.Token, request.NetworkID, request.PairID)
	}
	return nil, errors.New("p2p.invalid_operation")
}
