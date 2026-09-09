package controlplane

import (
	"context"
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func (client *Client) CurrentUser(ctx context.Context, token string) (User, error) {
	var result User
	err := client.call(ctx, "GET", "/v1/user", token, nil, &result)
	return result, err
}

func (client *Client) Logout(ctx context.Context, token string) error {
	var result struct {
		LoggedOut bool `json:"loggedOut"`
	}
	if err := client.call(ctx, "POST", "/v1/logout", token, struct{}{}, &result); err != nil {
		return err
	}
	if !result.LoggedOut {
		return errors.New("p2p.invalid_server_response")
	}
	return nil
}

func (client *Client) RenameNetwork(ctx context.Context, token, networkID, name string) (Network, error) {
	var result Network
	if !protocol.ValidID(networkID) {
		return result, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "PATCH", "/v1/networks/"+networkID, token, struct {
		Name string `json:"name"`
	}{name}, &result)
	return result, err
}

// UpdateNetworkLimit raises a network's device capacity. Only the owning user
// may raise it, and the coordinator refuses any value outside its allowed set,
// so the caller's choice is validated by the server rather than assumed here.
func (client *Client) UpdateNetworkLimit(ctx context.Context, token, networkID string, maxDevices int) (Network, error) {
	var result Network
	if !protocol.ValidID(networkID) {
		return result, errors.New("p2p.invalid_request")
	}
	err := client.call(ctx, "PATCH", "/v1/networks/"+networkID+"/limit", token, struct {
		MaxDevices int `json:"maxDevices"`
	}{maxDevices}, &result)
	return result, err
}

func (client *Client) DeleteNetwork(ctx context.Context, token, networkID string) error {
	if !protocol.ValidID(networkID) {
		return errors.New("p2p.invalid_request")
	}
	return client.deleteOwned(ctx, token, "/v1/networks/"+networkID)
}

// The directory returns DeviceEntry, not Device: the coordinator withholds
// certificates here and instead reports presence and the build each device
// declared, which is what a device list is actually for.
func (client *Client) UserDevices(ctx context.Context, token string) ([]DeviceEntry, error) {
	var result []DeviceEntry
	err := client.call(ctx, "GET", "/v1/devices", token, nil, &result)
	return result, err
}

func (client *Client) NetworkDevices(ctx context.Context, token, networkID string) ([]DeviceEntry, error) {
	if !protocol.ValidID(networkID) {
		return nil, errors.New("p2p.invalid_request")
	}
	var result []DeviceEntry
	err := client.call(ctx, "GET", "/v1/networks/"+networkID+"/devices", token, nil, &result)
	return result, err
}

func (client *Client) BindDevice(ctx context.Context, token, networkID, deviceID string) error {
	if !protocol.ValidID(networkID) || !protocol.ValidID(deviceID) {
		return errors.New("p2p.invalid_request")
	}
	var result struct {
		Bound bool `json:"bound"`
	}
	err := client.call(ctx, "POST", "/v1/networks/"+networkID+"/devices", token, struct {
		DeviceID string `json:"deviceId"`
	}{deviceID}, &result)
	if err != nil {
		return err
	}
	if !result.Bound {
		return errors.New("p2p.invalid_server_response")
	}
	return nil
}

func (client *Client) UnbindDevice(ctx context.Context, token, networkID, deviceID string) error {
	if !protocol.ValidID(networkID) || !protocol.ValidID(deviceID) {
		return errors.New("p2p.invalid_request")
	}
	var result struct {
		Unbound bool `json:"unbound"`
	}
	err := client.call(ctx, "DELETE", "/v1/networks/"+networkID+"/devices/"+deviceID, token, struct{}{}, &result)
	if err != nil {
		return err
	}
	if !result.Unbound {
		return errors.New("p2p.invalid_server_response")
	}
	return nil
}

func (client *Client) NetworkPairs(ctx context.Context, token, networkID string) ([]Pair, error) {
	if !protocol.ValidID(networkID) {
		return nil, errors.New("p2p.invalid_request")
	}
	var result []Pair
	err := client.call(ctx, "GET", "/v1/networks/"+networkID+"/pairs", token, nil, &result)
	return result, err
}

func (client *Client) DeletePair(ctx context.Context, token, networkID, pairID string) error {
	if !protocol.ValidID(networkID) || !protocol.ValidID(pairID) {
		return errors.New("p2p.invalid_request")
	}
	return client.deleteOwned(ctx, token, "/v1/networks/"+networkID+"/pairs/"+pairID)
}

func (client *Client) deleteOwned(ctx context.Context, token, path string) error {
	var result struct {
		Deleted bool `json:"deleted"`
	}
	if err := client.call(ctx, "DELETE", path, token, struct{}{}, &result); err != nil {
		return err
	}
	if !result.Deleted {
		return errors.New("p2p.invalid_server_response")
	}
	return nil
}
