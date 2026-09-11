// Package core is the headless core. It owns networking, the DSH lifecycle,
// the remote route and the credential store, and serves them to the shell over
// the private local channel documented in networking/docs/shell-core-protocol.md.
package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// Version is the core version reported to the shell and must equal the
// bootstrap and frame version of the private channel.
const Version = 1

// served lists the shell methods this core answers today. Every other method of
// localrpc.Methods is published but not yet implemented, and is refused with
// p2p.not_implemented so a caller never confuses an older core with a method
// that does not exist at all.
var served = map[string]bool{
	"core.version":       true,
	"core.secret_delete": true,
	"core.secret_get":    true,
	"core.secret_set":    true,
}

// Serve answers core methods against the platform secret store. A nil store
// is a legitimate configuration (a core without an explicit data root): every
// secret method is then refused with p2p.secret_provider_unavailable so a
// shell never mistakes "no provider" for an empty store.
type Serve struct {
	Store secret.Store
}

const maxSecretKeyBytes = 256

// MethodTable reports the methods this core answers, in published table order.
func MethodTable() []string {
	table := make([]string, 0, len(served))
	for _, method := range localrpc.Methods {
		if served[method.Name] {
			table = append(table, method.Name)
		}
	}
	return table
}

type versionResult struct {
	Version            int      `json:"version"`
	MethodTableVersion int      `json:"methodTableVersion"`
	Methods            []string `json:"methods"`
}

// Handle answers one shell request against no provider. It is kept as the
// package-level entry used by the helperless tests; the daemon uses Serve.Handle
// with the store its data root opened.
func Handle(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	return Serve{}.Handle(ctx, method, payload)
}

func secretKey(raw string) error {
	if raw == "" || len(raw) > maxSecretKeyBytes {
		return errors.New("p2p.invalid_payload")
	}
	return nil
}

// Handle answers one shell request. It is the core half of the version 1 method
// table: an unpublished method is a protocol error, a published method this
// core does not serve yet is p2p.not_implemented, and a payload that does not
// satisfy the method schema is refused by protocol.Decode itself.
func (server Serve) Handle(_ context.Context, method string, payload json.RawMessage) (any, error) {
	if method == "core.version" {
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		return versionResult{Version: Version, MethodTableVersion: localrpc.MethodTableVersion, Methods: MethodTable()}, nil
	}
	switch method {
	case "core.secret_get":
		var request struct {
			Key string `json:"key"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if err := secretKey(request.Key); err != nil {
			return nil, err
		}
		if server.Store == nil {
			return nil, secret.ErrUnavailable
		}
		value, err := server.Store.Get(request.Key)
		if err != nil {
			return nil, err
		}
		return struct {
			Value string `json:"value"`
		}{Value: base64.StdEncoding.EncodeToString(value)}, nil
	case "core.secret_set":
		var request struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if err := secretKey(request.Key); err != nil {
			return nil, err
		}
		if server.Store == nil {
			return nil, secret.ErrUnavailable
		}
		value, err := base64.StdEncoding.DecodeString(request.Value)
		if err != nil {
			return nil, errors.New("p2p.invalid_payload")
		}
		if err := server.Store.Set(request.Key, value); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	case "core.secret_delete":
		var request struct {
			Key string `json:"key"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if err := secretKey(request.Key); err != nil {
			return nil, err
		}
		if server.Store == nil {
			return nil, secret.ErrUnavailable
		}
		if err := server.Store.Delete(request.Key); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	}
	if _, published := localrpc.Lookup(method); published {
		return nil, errors.New("p2p.not_implemented")
	}
	return nil, errors.New("p2p.invalid_operation")
}
