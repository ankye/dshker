package integration

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
)

// Each real Manager represents a new core lifetime, not a WSS resubscription.
func integrationCoreInstanceID(t *testing.T) string {
	t.Helper()
	var nonce [16]byte
	_, err := rand.Read(nonce[:])
	must(t, err)
	return hex.EncodeToString(nonce[:])
}

// The real coordinator authorizes a fresh live pin after read-only registration.
// No cached PairIdentity, fixture key rewrite or v1 identity can grant this pin.
func integrationActivateManager(t *testing.T, ctx context.Context, manager *peersession.Manager, f *fixture, index int) {
	t.Helper()
	t.Cleanup(manager.Close)
	pin := f.config[index].Pin
	_, err := manager.PinScopedIdentity(ctx, f.userSession.User.UserID, pin.Pair.NetworkID, pin.Pair.PairID)
	must(t, err)
	must(t, manager.ActivateCandidates(ctx))
}

func integrationCatalogService(f *fixture) catalog.Service {
	return catalog.Service{
		ServiceID: f.authority.ServiceID, DisplayName: "integration-coordinator",
		HTTPSOrigin: f.endpoints.HTTPSOrigin, WSSURL: f.endpoints.WSSURL, STUNAddress: f.endpoints.STUNAddress,
		PublicKey: base64.StdEncoding.EncodeToString(f.authority.PublicKey), Certificate: base64.StdEncoding.EncodeToString(f.authority.Certificate),
	}
}

// Initial product setup registers a service, not any live computer authority.
func integrationConfigureCoreCatalog(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *fixture) {
	t.Helper()
	var enabled struct {
		Enabled  bool           `json:"enabled"`
		Revision string         `json:"revision"`
		Record   catalog.Record `json:"record"`
	}
	must(t, json.Unmarshal(callCore(t, ctx, parent, "core.catalog_enable", struct{}{}), &enabled))
	if !enabled.Enabled || enabled.Revision == "" || len(enabled.Record.Computers) != 0 {
		t.Fatal("new isolated catalog must be enabled without live pins")
	}
	enabled.Record.Services = []catalog.Service{integrationCatalogService(f)}
	callCore(t, ctx, parent, "core.catalog_commit", map[string]any{"expectedRevision": enabled.Revision, "record": enabled.Record})
}

func integrationOpenCatalog(t *testing.T, f *fixture) *catalog.Store {
	t.Helper()
	store, err := catalog.Open(t.TempDir())
	must(t, err)
	enabled, err := store.Enable()
	must(t, err)
	enabled.Record.Services = []catalog.Service{integrationCatalogService(f)}
	_, err = store.Commit(enabled.Revision, enabled.Record)
	must(t, err)
	return store
}

func integrationSessionRecord(t *testing.T, session controlplane.UserSession) []byte {
	t.Helper()
	data, err := json.Marshal(struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}{session.Token, session.ExpiresAt})
	must(t, err)
	return data
}

// Initial setup imports a real issued session; recovery must read it itself.
func integrationSelectCoreAccount(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *fixture) {
	t.Helper()
	callCore(t, ctx, parent, "core.secret_set", map[string]any{
		"key":   "peer-user-session:" + f.authority.ServiceID,
		"value": base64.StdEncoding.EncodeToString(integrationSessionRecord(t, f.userSession)),
	})
	callCore(t, ctx, parent, "user.current", map[string]any{
		"serviceId": f.authority.ServiceID, "data": map[string]string{"token": f.userSession.Token},
	})
}

func integrationSelectDirectAccount(t *testing.T, ctx context.Context, server core.Serve, serviceID string, session controlplane.UserSession) {
	t.Helper()
	secret, err := json.Marshal(map[string]any{
		"key":   "peer-user-session:" + serviceID,
		"value": base64.StdEncoding.EncodeToString(integrationSessionRecord(t, session)),
	})
	must(t, err)
	_, err = server.Handle(ctx, "core.secret_set", secret)
	must(t, err)
	current, err := json.Marshal(map[string]any{"serviceId": serviceID, "data": map[string]string{"token": session.Token}})
	must(t, err)
	_, err = server.Handle(ctx, "user.current", current)
	must(t, err)
}
