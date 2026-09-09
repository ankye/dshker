// Package helper owns named operations of the installed peer executable.
package helper

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

type Main interface {
	Call(context.Context, string, any) (json.RawMessage, error)
}
type Host struct {
	ctx      context.Context
	mu       sync.Mutex
	main     Main
	accounts map[string]*account
	closed   bool
}
type account struct {
	mu        sync.Mutex
	base      *controlplane.Client
	client    *controlplane.Client
	identity  controlplane.Identity
	endpoints controlplane.Endpoints
	device    controlplane.Device
	manager   *peersession.Manager
}
type scopedRequest struct {
	ServiceID string          `json:"serviceId"`
	Data      json.RawMessage `json:"data"`
}

func New(ctx context.Context) *Host   { return &Host{ctx: ctx, accounts: make(map[string]*account)} }
func (host *Host) BindMain(main Main) { host.mu.Lock(); host.main = main; host.mu.Unlock() }
func (host *Host) Close() {
	host.mu.Lock()
	host.closed = true
	accounts := make([]*account, 0, len(host.accounts))
	for _, value := range host.accounts {
		accounts = append(accounts, value)
	}
	host.mu.Unlock()
	for _, value := range accounts {
		value.mu.Lock()
		if value.manager != nil {
			value.manager.Close()
		}
		if value.client != nil {
			value.client.Close()
		}
		value.base.Close()
		value.mu.Unlock()
	}
}

func (host *Host) Handle(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	if ctx.Err() != nil {
		return nil, errors.New("p2p.request_cancelled")
	}
	host.mu.Lock()
	closedAtAdmission := host.closed
	host.mu.Unlock()
	if closedAtAdmission {
		return nil, errors.New("p2p.helper_unavailable")
	}
	if method == "service.configure" {
		return host.configure(ctx, payload)
	}
	if method == "device.createKey" {
		var empty struct{}
		if protocol.Decode(payload, &empty) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		key, csr, err := controlplane.NewDeviceKey()
		return struct {
			PrivateKey []byte `json:"privateKey"`
			CSR        string `json:"csr"`
		}{key, csr}, err
	}
	if method == "device.createCSR" {
		var request struct {
			PrivateKey []byte `json:"privateKey"`
		}
		if protocol.Decode(payload, &request) != nil {
			return nil, errors.New("p2p.invalid_request")
		}
		defer clear(request.PrivateKey)
		csr, err := controlplane.DeviceCSR(request.PrivateKey)
		return struct {
			CSR string `json:"csr"`
		}{csr}, err
	}
	var request scopedRequest
	if protocol.Decode(payload, &request) != nil {
		return nil, errors.New("p2p.invalid_request")
	}
	host.mu.Lock()
	account := host.accounts[request.ServiceID]
	closed := host.closed
	host.mu.Unlock()
	if account == nil || closed {
		return nil, errors.New("p2p.service_unconfigured")
	}
	if method == "peer.connect" || method == "peer.disconnect" || method == "runtime.invalidate" || method == "network.invalidate" || method == "remote.roots" || method == "remote.directory" {
		return account.connection(ctx, method, request.Data)
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	if method == "device.restore" {
		return host.restore(ctx, account, request.Data)
	}
	return account.management(ctx, method, request.Data)
}

func (host *Host) configure(ctx context.Context, payload json.RawMessage) (any, error) {
	var request struct {
		Endpoints controlplane.Endpoints `json:"endpoints"`
		PinnedKey []byte                 `json:"pinnedKey"`
		// The launcher owns its version string, so it is supplied here rather
		// than guessed by the helper. Absent telemetry reports nothing.
		Telemetry controlplane.Telemetry `json:"telemetry"`
	}
	if protocol.Decode(payload, &request) != nil || (len(request.PinnedKey) != 0 && len(request.PinnedKey) != 32) {
		return nil, errors.New("p2p.invalid_request")
	}
	base, err := controlplane.New(request.Endpoints, nil)
	if err != nil {
		return nil, err
	}
	base.SetTelemetry(request.Telemetry)
	var pinned ed25519.PublicKey
	if len(request.PinnedKey) > 0 {
		pinned = request.PinnedKey
	}
	identity, err := base.Identity(ctx, pinned)
	if err != nil {
		base.Close()
		return nil, err
	}
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.closed {
		base.Close()
		return nil, errors.New("p2p.helper_unavailable")
	}
	if previous := host.accounts[identity.ServiceID]; previous != nil {
		base.Close()
		if previous.endpoints != request.Endpoints {
			return nil, errors.New("p2p.service_busy")
		}
		return identity, nil
	}
	host.accounts[identity.ServiceID] = &account{base: base, identity: identity, endpoints: request.Endpoints}
	return identity, nil
}

func (host *Host) restore(ctx context.Context, account *account, data json.RawMessage) (any, error) {
	var request struct {
		Device     controlplane.Device         `json:"device"`
		PrivateKey []byte                      `json:"privateKey"`
		Pins       []controlplane.PairIdentity `json:"pins"`
	}
	if protocol.Decode(data, &request) != nil || account.manager != nil {
		return nil, errors.New("p2p.invalid_device_state")
	}
	client, err := account.base.WithDevice(request.Device, request.PrivateKey, account.identity)
	if err != nil {
		return nil, err
	}
	host.mu.Lock()
	main := host.main
	host.mu.Unlock()
	if main == nil {
		client.Close()
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	owner := func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		data, err := main.Call(ctx, "runtime.connect", struct {
			ServiceID string `json:"serviceId"`
			PairID    string `json:"pairId"`
		}{account.identity.ServiceID, pairID})
		var binding runtimebridge.Binding
		if err == nil {
			err = protocol.Decode(data, &binding)
		}
		return binding, err
	}
	emit := func(state peersession.State) {
		ctx, cancel := context.WithTimeout(host.ctx, 5*time.Second)
		defer cancel()
		main.Call(ctx, "peer.state", struct {
			ServiceID string            `json:"serviceId"`
			State     peersession.State `json:"state"`
		}{account.identity.ServiceID, state})
	}
	manager, err := peersession.New(host.ctx, client, peersession.Config{Endpoints: account.endpoints, Authority: account.identity, Device: request.Device, PrivateKey: request.PrivateKey}, request.Pins, owner, emit)
	if err != nil {
		client.Close()
		return nil, err
	}
	account.client, account.manager, account.device = client, manager, request.Device
	return struct {
		DeviceID string `json:"deviceId"`
	}{request.Device.DeviceID}, nil
}

func (account *account) connection(ctx context.Context, method string, data json.RawMessage) (any, error) {
	account.mu.Lock()
	manager := account.manager
	account.mu.Unlock()
	if method == "network.invalidate" {
		var request struct {
			NetworkID string `json:"networkId"`
		}
		if protocol.Decode(data, &request) != nil || !protocol.ValidID(request.NetworkID) {
			return nil, errors.New("p2p.invalid_request")
		}
		// A configured account with no device manager owns no local peer authority.
		if manager == nil {
			return struct{}{}, nil
		}
		return struct{}{}, manager.RevokeNetwork(request.NetworkID)
	}
	if manager == nil {
		return nil, errors.New("p2p.device_unregistered")
	}
	if method == "runtime.invalidate" {
		var request struct {
			Generation uint64 `json:"generation"`
		}
		if protocol.Decode(data, &request) != nil || request.Generation == 0 {
			return nil, errors.New("p2p.invalid_request")
		}
		manager.InvalidateRuntime(request.Generation)
		return struct{}{}, nil
	}
	if method == "remote.roots" {
		var request struct {
			PairID string `json:"pairId"`
		}
		if protocol.Decode(data, &request) != nil || !protocol.ValidID(request.PairID) {
			return nil, errors.New("p2p.invalid_request")
		}
		roots, err := manager.RemoteRoots(ctx, request.PairID)
		if err != nil {
			return nil, err
		}
		return struct {
			Roots []runtimebridge.Root `json:"roots"`
		}{roots}, nil
	}
	if method == "remote.directory" {
		var request struct {
			PairID string `json:"pairId"`
			RootID string `json:"rootId"`
			Ref    string `json:"ref"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
		}
		if protocol.Decode(data, &request) != nil || !protocol.ValidID(request.PairID) || request.RootID == "" {
			return nil, errors.New("p2p.invalid_request")
		}
		entries, total, err := manager.RemoteDirectory(ctx, request.PairID, request.RootID, request.Ref, request.Offset, request.Limit)
		if err != nil {
			return nil, err
		}
		return struct {
			Entries []runtimebridge.Entry `json:"entries"`
			Total   int                   `json:"total"`
		}{entries, total}, nil
	}
	if method == "peer.disconnect" {
		var request struct {
			PairID string `json:"pairId"`
		}
		if protocol.Decode(data, &request) != nil || !protocol.ValidID(request.PairID) {
			return nil, errors.New("p2p.invalid_request")
		}
		return struct{}{}, manager.Disconnect(request.PairID)
	}
	var request struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}
	if protocol.Decode(data, &request) != nil || !protocol.ValidID(request.PairID) || request.Generation == 0 {
		return nil, errors.New("p2p.invalid_request")
	}
	return manager.Connect(ctx, request.PairID, request.Generation)
}
