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
	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/installcatalog"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peerbroker"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/remoteconnections"
	"github.com/ankye/dshker/networking/internal/remoteroute"
	"github.com/ankye/dshker/networking/internal/rootregistry"
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
	"core.version":                 true,
	"core.catalog_commit":          true,
	"core.catalog_enable":          true,
	"core.catalog_inspect":         true,
	"core.catalog_remove_service":  true,
	"core.install_catalog_commit":  true,
	"core.install_catalog_inspect": true,
	"core.roots_commit":            true,
	"core.roots_inspect":           true,
	"core.secret_delete":           true,
	"core.secret_get":              true,
	"core.secret_set":              true,
	"runtime.console":              true,
	"runtime.port_get":             true,
	"runtime.port_set":             true,
	"remote.catalog_create":        true,
	"remote.catalog_inspect":       true,
	"remote.catalog_remove":        true,
	"remote.catalog_update":        true,
	"remote.broker_start":          true,
	"remote.broker_status":         true,
	"remote.broker_stop":           true,
	"remote.connect":               true,
	"remote.disconnect":            true,
	"remote.status":                true,
	"runtime.start":                true,
	"runtime.status":               true,
	"runtime.stop":                 true,
	"core.runtime_binding":         true,
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
	// Runtime is the DSH Web process authority. A composition without it cannot
	// run children at all, which is what the daemon-less unit tests are.
	Runtime *harnessruntime.Supervisor
	// Remote is the SSH route authority: the descriptor transfer, the two port
	// forwards, and the loopback broker call for each connection.
	Remote *remoteroute.Route
	// Brokers is the server half of that route: the endpoint a remote peer
	// reaches, and the descriptor it is told about.
	Brokers *peerbroker.Holder
	// RuntimeBinding answers what a peer is handed when it asks this host for a
	// workbench: the loopback address of the running child and its generation.
	// A composition without one refuses, exactly as a host with no child does.
	RuntimeBinding *RuntimeBinding
}

// runtimeResult, runtimeStatusResult, runtimeConsoleResult and runtimePortResult
// are the shell-facing envelopes. Each reuses the runtime package's own wire
// shapes so the shell parses them with the contract it already renders.
type runtimeResult struct {
	Launch *harnessruntime.LaunchView `json:"launch,omitempty"`
}

type runtimeStatusResult struct {
	Launch  *harnessruntime.LaunchView `json:"launch,omitempty"`
	Present bool                       `json:"present"`
}

type runtimeConsoleResult struct {
	Entries []harnessruntime.ConsoleEntry `json:"entries"`
	Cursor  int64                         `json:"cursor"`
}

type runtimePortResult struct {
	Port harnessruntime.PortSetting `json:"port"`
}

// remoteRoute reports the SSH route this composition was given.
func (server Serve) remoteRoute() (*remoteroute.Route, error) {
	if server.Remote == nil {
		return nil, errors.New("p2p.not_implemented")
	}
	return server.Remote, nil
}

// remoteCatalogResult reuses the catalog's own wire shape, so the shell parses it
// with the validator it used while it owned the file. The revision is the one the
// shell already computes for a stale-edit check.
type remoteCatalogResult struct {
	Connections []remoteCatalogConnection `json:"connections"`
}

type remoteCatalogConnection struct {
	ConnectionID   string `json:"connectionId"`
	DisplayName    string `json:"displayName"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	ConfigRevision string `json:"configRevision"`
}

func remoteCatalogSnapshot(connections []remoteconnections.Computer) remoteCatalogResult {
	projected := make([]remoteCatalogConnection, 0, len(connections))
	for _, connection := range connections {
		projected = append(projected, remoteCatalogConnection{
			ConnectionID:   connection.ConnectionID,
			DisplayName:    connection.DisplayName,
			Host:           connection.Host,
			Port:           connection.Port,
			User:           connection.User,
			ConfigRevision: remoteconnections.ConfigRevision(connection),
		})
	}
	return remoteCatalogResult{Connections: projected}
}

// remoteBrokerResult, remoteBrokerStatusResult and remoteResult reuse the route's
// own wire shapes.
type remoteBrokerResult struct {
	Port       int    `json:"port"`
	InstanceID string `json:"instanceId"`
}

type remoteBrokerStatusResult struct {
	Present    bool   `json:"present"`
	Port       int    `json:"port,omitempty"`
	InstanceID string `json:"instanceId,omitempty"`
}
type remoteResult struct {
	URL string `json:"url"`
}

type remoteStatusResult struct {
	URL     string `json:"url,omitempty"`
	Present bool   `json:"present"`
}

// runtimeSupervisor reports the process supervisor this composition was given.
// A core started without one refuses these methods rather than pretending the
// child is somewhere else.
func (server Serve) runtimeSupervisor() (*harnessruntime.Supervisor, error) {
	if server.Runtime == nil {
		return nil, errors.New("p2p.not_implemented")
	}
	return server.Runtime, nil
}

// installCatalogResult reuses the installation catalog's own wire shape, so the
// shell parses it with the validator it used while it owned the file.
type installCatalogResult struct {
	Catalog installcatalog.Catalog `json:"catalog"`
}

// rootsResult reuses the registry's own wire shape, so the shell parses it with
// the validator it used while it owned the file.
type rootsResult struct {
	Registry rootregistry.Registry `json:"registry"`
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
	case "runtime.start":
		var request struct {
			LaunchID              string                     `json:"launchId"`
			SubjectID             string                     `json:"subjectId"`
			Directory             string                     `json:"directory"`
			Profile               string                     `json:"profile"`
			NodeExecutable        string                     `json:"nodeExecutable"`
			PnpmExecutable        string                     `json:"pnpmExecutable"`
			PnpmPrefixArguments   []string                   `json:"pnpmPrefixArguments"`
			PnpmResolutionError   string                     `json:"pnpmResolutionError"`
			PnpmCommandSearchPath string                     `json:"pnpmCommandSearchPath"`
			DiagnosticsPatchPath  string                     `json:"diagnosticsPatchPath"`
			Port                  harnessruntime.PortSetting `json:"port"`
			LogPath               string                     `json:"logPath"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		supervisor, err := server.runtimeSupervisor()
		if err != nil {
			return nil, err
		}
		// A fixed port is prepared before anything is spawned: a leftover DSH Web
		// the core itself started is adopted, and any other holder is refused with
		// the message the renderer explains.
		if request.Port.Mode == "fixed" {
			asserted, err := harnessruntime.AssertPortSetting(request.Port)
			if err != nil {
				return nil, err
			}
			decision := harnessruntime.PreparePortForLaunch(asserted.Port, supervisor.Platform(), harnessruntime.PortPreparation{})
			if decision.Kind == harnessruntime.PortForeign {
				return nil, harnessruntime.ForeignPortFailure(asserted.Port, *decision.Occupant)
			}
		}
		view, err := supervisor.Start(harnessruntime.LaunchRequest{
			LaunchID:              request.LaunchID,
			SubjectID:             request.SubjectID,
			Directory:             request.Directory,
			Profile:               request.Profile,
			NodeExecutable:        request.NodeExecutable,
			PnpmExecutable:        request.PnpmExecutable,
			PnpmPrefixArguments:   request.PnpmPrefixArguments,
			PnpmResolutionError:   request.PnpmResolutionError,
			PnpmCommandSearchPath: request.PnpmCommandSearchPath,
			DiagnosticsPatchPath:  request.DiagnosticsPatchPath,
			Port:                  request.Port,
			LogPath:               request.LogPath,
		})
		if err != nil {
			return nil, err
		}
		return runtimeResult{Launch: &view}, nil
	case "core.runtime_binding":
		// The reverse-proxy half of hosting, asked directly rather than by a peer
		// transport: a caller with no desktop session can see the address this
		// machine would bind a peer to, and the generation that identifies it.
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.RuntimeBinding == nil {
			return nil, ErrRuntimeUnavailable
		}
		return server.RuntimeBinding.Binding()
	case "runtime.stop":
		var request struct {
			SubjectID string `json:"subjectId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		supervisor, err := server.runtimeSupervisor()
		if err != nil {
			return nil, err
		}
		view, err := supervisor.Stop(request.SubjectID)
		if err != nil {
			return nil, err
		}
		return runtimeResult{Launch: &view}, nil
	case "runtime.status":
		var request struct {
			SubjectID string `json:"subjectId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		supervisor, err := server.runtimeSupervisor()
		if err != nil {
			return nil, err
		}
		view, present := supervisor.Status(request.SubjectID)
		if !present {
			return runtimeStatusResult{}, nil
		}
		return runtimeStatusResult{Launch: &view, Present: true}, nil
	case "remote.catalog_inspect":
		var request struct {
			FilePath string `json:"filePath"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := remoteconnections.Open(request.FilePath)
		if err != nil {
			return nil, err
		}
		record, err := store.Load()
		if err != nil {
			return nil, err
		}
		return remoteCatalogSnapshot(record.Connections), nil
	case "remote.catalog_create":
		var request struct {
			FilePath    string `json:"filePath"`
			DisplayName string `json:"displayName"`
			Host        string `json:"host"`
			Port        int    `json:"port"`
			User        string `json:"user"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := remoteconnections.Open(request.FilePath)
		if err != nil {
			return nil, err
		}
		connections, err := store.Create(request.DisplayName, request.Host, request.Port, request.User)
		if err != nil {
			return nil, err
		}
		return remoteCatalogSnapshot(connections), nil
	case "remote.catalog_update":
		var request struct {
			FilePath               string `json:"filePath"`
			ConnectionID           string `json:"connectionId"`
			DisplayName            string `json:"displayName"`
			Host                   string `json:"host"`
			Port                   int    `json:"port"`
			User                   string `json:"user"`
			ExpectedConfigRevision string `json:"expectedConfigRevision"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := remoteconnections.Open(request.FilePath)
		if err != nil {
			return nil, err
		}
		connections, err := store.Update(request.ConnectionID, request.DisplayName, request.Host, request.Port, request.User, request.ExpectedConfigRevision)
		if err != nil {
			return nil, err
		}
		return remoteCatalogSnapshot(connections), nil
	case "remote.catalog_remove":
		var request struct {
			FilePath     string `json:"filePath"`
			ConnectionID string `json:"connectionId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := remoteconnections.Open(request.FilePath)
		if err != nil {
			return nil, err
		}
		connections, err := store.Remove(request.ConnectionID)
		if err != nil {
			return nil, err
		}
		return remoteCatalogSnapshot(connections), nil
	case "remote.broker_start":
		var request struct {
			DescriptorPath string `json:"descriptorPath"`
			SubjectID      string `json:"subjectId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Brokers == nil || server.Runtime == nil {
			return nil, errors.New("p2p.not_implemented")
		}
		holder := server.Brokers
		supervisor := server.Runtime
		// The endpoint answers with the session this host already runs: a peer
		// asks for a runtime, it does not get to start one.
		runtime := func(ctx context.Context) (string, error) {
			view, present := supervisor.Status(request.SubjectID)
			if !present || view.State != harnessruntime.StateRunning || view.URL == "" {
				return "", errors.New("remote.runtime_unavailable")
			}
			return view.URL, nil
		}
		descriptor, err := holder.Start(request.DescriptorPath, runtime, "")
		if err != nil {
			return nil, err
		}
		return remoteBrokerResult{Port: descriptor.Port, InstanceID: descriptor.InstanceID}, nil
	case "remote.broker_stop":
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Brokers == nil {
			return nil, errors.New("p2p.not_implemented")
		}
		if err := server.Brokers.Stop(); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	case "remote.broker_status":
		var request struct{}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		if server.Brokers == nil {
			return nil, errors.New("p2p.not_implemented")
		}
		descriptor, live := server.Brokers.Status()
		if !live {
			return remoteBrokerStatusResult{}, nil
		}
		return remoteBrokerStatusResult{Present: true, Port: descriptor.Port, InstanceID: descriptor.InstanceID}, nil
	case "remote.connect":
		var request struct {
			ConnectionID string               `json:"connectionId"`
			Computer     remoteroute.Computer `json:"computer"`
			SSH          string               `json:"ssh"`
			SCP          string               `json:"scp"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		route, err := server.remoteRoute()
		if err != nil {
			return nil, err
		}
		// A caller may name the OpenSSH clients; that is how a host with a
		// non-standard installation and the tests say which pair to use. The route
		// still owns the generation.
		connector := route.Connector
		if request.SSH != "" {
			connector.Executables.SSH = request.SSH
		}
		if request.SCP != "" {
			connector.Executables.SCP = request.SCP
		}
		url, err := route.ConnectWith(ctx, request.ConnectionID, request.Computer, connector, nil)
		if err != nil {
			return nil, err
		}
		return remoteResult{URL: url}, nil
	case "remote.disconnect":
		var request struct {
			ConnectionID string `json:"connectionId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		route, err := server.remoteRoute()
		if err != nil {
			return nil, err
		}
		if err := route.Disconnect(request.ConnectionID); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	case "remote.status":
		var request struct {
			ConnectionID string `json:"connectionId"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		route, err := server.remoteRoute()
		if err != nil {
			return nil, err
		}
		url, live := route.URL(request.ConnectionID)
		if !live {
			return remoteStatusResult{}, nil
		}
		return remoteStatusResult{URL: url, Present: true}, nil
	case "runtime.console":
		var request struct {
			Cursor int64 `json:"cursor"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		supervisor, err := server.runtimeSupervisor()
		if err != nil {
			return nil, err
		}
		entries, cursor := supervisor.Console().After(request.Cursor)
		return runtimeConsoleResult{Entries: entries, Cursor: cursor}, nil
	case "runtime.port_get":
		var request struct {
			FilePath string `json:"filePath"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := harnessruntime.OpenPreferences(request.FilePath)
		if err != nil {
			return nil, err
		}
		setting, err := store.Load()
		if err != nil {
			return nil, err
		}
		return runtimePortResult{Port: setting}, nil
	case "runtime.port_set":
		var request struct {
			FilePath string                     `json:"filePath"`
			Port     harnessruntime.PortSetting `json:"port"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := harnessruntime.OpenPreferences(request.FilePath)
		if err != nil {
			return nil, err
		}
		setting, err := harnessruntime.AssertPortSetting(request.Port)
		if err != nil {
			return nil, err
		}
		if err := store.Save(setting); err != nil {
			return nil, err
		}
		return runtimePortResult{Port: setting}, nil
	case "core.install_catalog_inspect":
		var request struct {
			FilePath string `json:"filePath"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := installcatalog.Open(request.FilePath)
		if err != nil {
			return nil, err
		}
		catalogRecord, err := store.Load()
		if err != nil {
			return nil, err
		}
		return installCatalogResult{Catalog: catalogRecord}, nil
	case "core.install_catalog_commit":
		var request struct {
			FilePath string                 `json:"filePath"`
			Catalog  installcatalog.Catalog `json:"catalog"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		// The store re-validates every field, publishes atomically and proves the
		// published bytes, so a shell bug cannot persist a catalog the core would
		// refuse to load on the next start.
		store, err := installcatalog.Open(request.FilePath)
		if err != nil {
			return nil, err
		}
		if err := store.Save(request.Catalog); err != nil {
			return nil, err
		}
		return installCatalogResult{Catalog: request.Catalog}, nil
	case "core.roots_inspect":
		var request struct {
			FilePath      string `json:"filePath"`
			NativeDshHome string `json:"nativeDshHome"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		store, err := rootregistry.Open(request.FilePath, request.NativeDshHome)
		if err != nil {
			return nil, err
		}
		registry, err := store.Load()
		if err != nil {
			return nil, err
		}
		return rootsResult{Registry: registry}, nil
	case "core.roots_commit":
		var request struct {
			FilePath      string                `json:"filePath"`
			NativeDshHome string                `json:"nativeDshHome"`
			Registry      rootregistry.Registry `json:"registry"`
		}
		if err := protocol.Decode(payload, &request); err != nil {
			return nil, err
		}
		// The store validates the whole topology, publishes atomically and proves
		// the published bytes, so a shell bug cannot persist a registry the core
		// would refuse to load on the next start.
		store, err := rootregistry.Open(request.FilePath, request.NativeDshHome)
		if err != nil {
			return nil, err
		}
		if err := store.Save(request.Registry); err != nil {
			return nil, err
		}
		return rootsResult{Registry: request.Registry}, nil
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
