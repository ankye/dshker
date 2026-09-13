// Package core is the headless core. It owns networking, the DSH lifecycle,
// the remote route and the credential store, and serves them to the shell over
// the private local channel documented in networking/docs/shell-core-protocol.md.
package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// Version is the core version reported to the shell and must equal the
// bootstrap and frame version of the private channel.
const Version = 1

// served lists the methods the core answers itself, against its own stores.
// Every other shell-role method of localrpc.Methods is answered by the
// installed-peer host composed beside it (see Peer); a composition without that
// host refuses them with p2p.not_implemented so a caller never confuses an
// older core with a method that does not exist at all.
var served = map[string]bool{
	"core.version":                true,
	"core.catalog_commit":         true,
	"core.catalog_enable":         true,
	"core.catalog_inspect":        true,
	"core.catalog_remove_service": true,
	"core.secret_delete":          true,
	"core.secret_get":             true,
	"core.secret_set":             true,
}

// Peer is the installed-peer half of the table: the coordinator, pairing,
// enrollment and runtime operations. The daemon passes the same host the peer
// executable uses, so one process now answers the whole published table; a
// composition without it (the helperless unit tests) keeps refusing those
// methods with p2p.not_implemented.
type Peer interface {
	Handle(ctx context.Context, method string, payload json.RawMessage) (any, error)
}

// Serve answers the shell over the private channel. A nil store is a legitimate
// configuration (a core without an explicit data root): every secret method is
// then refused with p2p.secret_provider_unavailable so a shell never mistakes
// "no provider" for an empty store. The catalog behaves the same way — a core
// that was not given a catalog directory refuses those methods rather than
// reporting an empty catalog, which would be a silent state loss.
type Serve struct {
	Store   secret.Store
	Catalog *catalog.Store
	Peer    Peer
}

// catalogResult is the shell-facing view of the catalog. It reuses the record's
// own wire shape on purpose, so the shell parses it with the same validator it
// used while it still owned the file.
type catalogResult struct {
	Enabled  bool            `json:"enabled"`
	Revision string          `json:"revision,omitempty"`
	Record   *catalog.Record `json:"record,omitempty"`
}

// catalogSnapshot renders one store answer for the shell.
func catalogSnapshot(snapshot *catalog.Snapshot) catalogResult {
	if snapshot == nil {
		return catalogResult{Enabled: false}
	}
	record := snapshot.Record
	return catalogResult{Enabled: true, Revision: snapshot.Revision, Record: &record}
}

const maxSecretKeyBytes = 256

// MethodTable reports the shell-role methods this composition answers, in
// published table order. With a peer host that is the whole shell table; without
// one it is only what the core owns itself, which is what the package-level
// Handle answers.
func (server Serve) MethodTable() []string {
	table := make([]string, 0, len(localrpc.Methods))
	for _, method := range localrpc.Methods {
		if method.Role != localrpc.RoleShell {
			continue
		}
		if served[method.Name] || server.Peer != nil {
			table = append(table, method.Name)
		}
	}
	return table
}

// MethodTable reports what a core with no peer host answers.
func MethodTable() []string { return Serve{}.MethodTable() }

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

// Handle answers one shell request. It is the version 1 method table: the core's
// own methods are answered here, every other shell-role method is handed to the
// composed peer host, an inbound parent-role method is refused as an invalid
// operation (it is a callback the core sends), and a payload that does not
// satisfy the method schema is refused by protocol.Decode itself.
func (server Serve) Handle(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	if method == "core.version" {
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		return versionResult{Version: Version, MethodTableVersion: localrpc.MethodTableVersion, Methods: server.MethodTable()}, nil
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
	case "core.catalog_inspect":
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Catalog == nil {
			return nil, catalog.ErrUnavailable
		}
		snapshot, err := server.Catalog.Inspect()
		if err != nil {
			return nil, err
		}
		// No snapshot is "never enabled", which is a state the shell renders as an
		// invitation to enable rather than as an error.
		return catalogSnapshot(snapshot), nil
	case "core.catalog_enable":
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Catalog == nil {
			return nil, catalog.ErrUnavailable
		}
		snapshot, err := server.Catalog.Enable()
		if err != nil {
			return nil, err
		}
		return catalogSnapshot(&snapshot), nil
	case "core.catalog_commit":
		var request struct {
			ExpectedRevision string         `json:"expectedRevision"`
			Record           catalog.Record `json:"record"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Catalog == nil {
			return nil, catalog.ErrUnavailable
		}
		// The store re-validates the record and enforces identity continuity, so a
		// shell bug cannot replace a trusted key or drop a pair silently.
		snapshot, err := server.Catalog.Commit(request.ExpectedRevision, request.Record)
		if err != nil {
			return nil, err
		}
		return catalogSnapshot(&snapshot), nil
	case "core.catalog_remove_service":
		var request struct {
			ServiceID string `json:"serviceId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Catalog == nil {
			return nil, catalog.ErrUnavailable
		}
		snapshot, err := server.Catalog.RemoveService(request.ServiceID)
		if err != nil {
			return nil, err
		}
		return catalogSnapshot(&snapshot), nil
	}
	entry, published := localrpc.Lookup(method)
	if !published || entry.Role != localrpc.RoleShell {
		// Either no such method, or a parent-role callback (runtime.connect,
		// peer.state) that the core sends rather than answers. The conformance
		// fixture refuses an inbound callback the same way.
		return nil, errors.New("p2p.invalid_operation")
	}
	if server.Peer != nil && !isCoreMethod(method) {
		return server.Peer.Handle(ctx, method, payload)
	}
	// Published, shell-role, and not the peer host's to answer: either no host is
	// composed at all, or this build has not implemented a core.* method yet.
	return nil, errors.New("p2p.not_implemented")
}

// isCoreMethod reports whether a published method belongs to the core's own
// group. Every one of them is answered by the switch above; one published but
// absent from it is a build that has not implemented it yet, which is exactly
// what p2p.not_implemented means and is not something the peer host can answer.
func isCoreMethod(method string) bool { return strings.HasPrefix(method, "core.") }
