// Package core is the headless core. It owns networking, the DSH lifecycle,
// the remote route and the credential store, and serves them to the shell over
// the private local channel documented in networking/docs/shell-core-protocol.md.
package core

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Version is the core version reported to the shell and must equal the
// bootstrap and frame version of the private channel.
const Version = 1

// served lists the shell methods this core answers today. Every other method of
// localrpc.Methods is published but not yet implemented, and is refused with
// p2p.not_implemented so a caller never confuses an older core with a method
// that does not exist at all.
var served = map[string]bool{"core.version": true}

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

// Handle answers one shell request. It is the core half of the version 1 method
// table: an unpublished method is a protocol error, a published method this
// core does not serve yet is p2p.not_implemented, and a payload that does not
// satisfy the method schema is refused by protocol.Decode itself.
func Handle(_ context.Context, method string, payload json.RawMessage) (any, error) {
	if method == "core.version" {
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		return versionResult{Version: Version, MethodTableVersion: localrpc.MethodTableVersion, Methods: MethodTable()}, nil
	}
	if _, published := localrpc.Lookup(method); published {
		return nil, errors.New("p2p.not_implemented")
	}
	return nil, errors.New("p2p.invalid_operation")
}
