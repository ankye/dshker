//go:build windows

package integration

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/secret"
)

// This integration uses the production Windows DPAPI provider with an explicit
// temporary root. Other platforms' providers use shared OS credential namespaces
// and cannot safely use this test's directory as isolation.
type authorizedRecoveryEvents struct {
	mu           sync.Mutex
	runtimeCalls int
}

func (events *authorizedRecoveryEvents) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	switch method {
	case "catalog.changed", "directory.changed", "peer.state":
		return json.RawMessage(`{}`), nil
	default:
		events.mu.Lock()
		events.runtimeCalls++
		events.mu.Unlock()
		return nil, errors.New("test.unexpected_runtime_or_parent_request")
	}
}

func authorizedRecoveryHost(t *testing.T, f *realCoordinator, store secret.Store, catalogStore *catalog.Store, events *authorizedRecoveryEvents) (*helper.Host, core.Serve) {
	t.Helper()
	host := helper.New(f.ctx)
	root, err := x509.ParseCertificate(f.root)
	must(t, err)
	roots := x509.NewCertPool()
	roots.AddCert(root)
	host.SetRoots(roots)
	host.SetDeviceKeys(store)
	host.SetCatalog(catalogStore)
	host.BindMain(events)
	t.Cleanup(host.Close)
	return host, core.Serve{Store: store, Peer: host, Catalog: catalogStore}
}

func authorizedRecoveryReadback(t *testing.T, ctx context.Context, f *realCoordinator, server core.Serve) string {
	t.Helper()
	value, err := server.Handle(ctx, "core.catalog_inspect", json.RawMessage(`{}`))
	must(t, err)
	saved := hostColdDecode[struct {
		Enabled  bool           `json:"enabled"`
		Revision string         `json:"revision"`
		Record   catalog.Record `json:"record"`
	}](t, value)
	if !saved.Enabled || len(saved.Record.Computers) != 1 {
		t.Fatal("automatic recovery did not retain exactly the original computer")
	}
	computer := saved.Record.Computers[0]
	local, remote, pair := f.config[0].Device, f.config[1].Device, f.config[0].Pin.Pair
	if computer.PairState != "active" || computer.ConnectionID != remote.DeviceID || computer.PairID != remote.DeviceID ||
		computer.ServiceID != f.authority.ServiceID || computer.UserID != f.userSession.User.UserID || computer.NetworkID != pair.NetworkID ||
		computer.LocalDeviceID != local.DeviceID || computer.RemoteDeviceID != remote.DeviceID || computer.PairRevision != int64(pair.Revision) ||
		computer.LocalPublicKey != base64.StdEncoding.EncodeToString(local.PublicKey) || computer.RemotePublicKey != base64.StdEncoding.EncodeToString(remote.PublicKey) {
		t.Fatal("automatic recovery changed original authorization scope instead of restoring its active state")
	}
	value, err = server.Handle(ctx, "pairs.network_choices", json.RawMessage(envelope(t, f.authority.ServiceID, map[string]any{})))
	must(t, err)
	choices := hostColdDecode[helper.NetworkChoices](t, value)
	if choices.UserID != f.userSession.User.UserID || choices.CatalogRevision != saved.Revision || len(choices.Devices) != 1 ||
		choices.Devices[0].PairID != remote.DeviceID || choices.Devices[0].State != "selected" || choices.Devices[0].SelectedNetworkID != pair.NetworkID {
		t.Fatal("fresh automatic recovery still requires explicit network selection")
	}
	return saved.Revision
}

// All authority comes from one independently launched production coordinator;
// DPAPI, catalog persistence, account bootstrap and helper dispatch are real.
// The only parent callbacks acknowledge notifications and reject runtime starts.
func TestAuthorizedNetworkRecoveryRealCoordinatorRestoresRevokedOriginalScope(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 40*time.Second)
	defer cancel()
	store, err := secret.Open(t.TempDir())
	must(t, err)
	catalogRoot := t.TempDir()
	catalogStore, err := catalog.Open(catalogRoot)
	must(t, err)
	saved, err := catalogStore.Enable()
	must(t, err)
	saved.Record.Services = []catalog.Service{integrationCatalogService(f)}
	local, remote, pair := f.config[0].Device, f.config[1].Device, f.config[0].Pin.Pair
	saved.Record.Computers = []catalog.Computer{{
		ConnectionID: remote.DeviceID, ServiceID: f.authority.ServiceID, DisplayName: remote.Name,
		PairID: remote.DeviceID, NetworkID: pair.NetworkID, LocalDeviceID: local.DeviceID, RemoteDeviceID: remote.DeviceID,
		UserID: f.userSession.User.UserID, LocalPublicKey: base64.StdEncoding.EncodeToString(local.PublicKey),
		RemotePublicKey: base64.StdEncoding.EncodeToString(remote.PublicKey), PairRevision: int64(pair.Revision), PairState: "revoked",
	}}
	_, err = catalogStore.Commit(saved.Revision, saved.Record)
	must(t, err)
	events := &authorizedRecoveryEvents{}
	seed, server := authorizedRecoveryHost(t, f, store, catalogStore, events)
	configuration, err := json.Marshal(map[string]any{"endpoints": f.endpoints, "pinnedKey": f.authority.PublicKey, "telemetry": controlplane.Telemetry{}})
	must(t, err)
	_, err = server.Handle(ctx, "service.configure", configuration)
	must(t, err)
	must(t, seed.SaveCredential(f.authority.ServiceID, local, f.config[0].Private))
	session := integrationSessionRecord(t, f.userSession)
	must(t, store.Set("peer-user-session:"+f.authority.ServiceID, session))
	seed.Close()

	host, server := authorizedRecoveryHost(t, f, store, catalogStore, events)
	if restored := host.RestoreOwnCredentials(ctx); restored != 1 {
		t.Fatal("cold bootstrap did not restore its exact original credential", restored)
	}
	revision := authorizedRecoveryReadback(t, ctx, f, server)
	// The next two assertions are independent requests, not recovery retries.
	// Preserve the production source budget rather than spending a whole cold
	// bootstrap plus repeated confirmations in the same limiter window.
	waitForRequestBudget()
	_, err = server.Handle(ctx, "user.current", json.RawMessage(envelope(t, f.authority.ServiceID, map[string]any{"token": f.userSession.Token})))
	must(t, err)
	if next := authorizedRecoveryReadback(t, ctx, f, server); next != revision {
		t.Fatal("repeated authoritative synchronization changed the durable active choice")
	}
	host.Close()
	waitForRequestBudget()
	reopened, err := catalog.Open(catalogRoot)
	must(t, err)
	restarted, server := authorizedRecoveryHost(t, f, store, reopened, events)
	if restored := restarted.RestoreOwnCredentials(ctx); restored != 1 {
		t.Fatal("restart did not restore the same persisted device and choice", restored)
	}
	if next := authorizedRecoveryReadback(t, ctx, f, server); next != revision {
		t.Fatal("restart did not read back the original recovered authorization")
	}
	actual, err := f.devices[0].PairIdentity(ctx, pair.PairID)
	must(t, err)
	if actual.Pair != pair {
		t.Fatal("automatic local recovery rewrote the server pairing")
	}
	storedSession, err := store.Get("peer-user-session:" + f.authority.ServiceID)
	must(t, err)
	if !bytes.Equal(session, storedSession) {
		t.Fatal("automatic recovery rewrote the user's original signed-in session")
	}
	events.mu.Lock()
	calls := events.runtimeCalls
	events.mu.Unlock()
	if calls != 0 {
		t.Fatal("network authorization synchronization attempted to start a runtime", calls)
	}
	t.Logf("authorized-network-recovery service=%s user=%s local=%s remote=%s network=%s pair=%s revision=%d state=active choice=selected repeated=unchanged restart=unchanged runtimeCalls=0",
		f.authority.ServiceID, f.userSession.User.UserID, local.DeviceID, remote.DeviceID, pair.NetworkID, pair.PairID, pair.Revision)
}
