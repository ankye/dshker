//go:build linux

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// Run in a fresh dbus-run-session with an unlocked Secret Service, as the Linux
// integration CI does. The production CLI and its OS provider own all writes;
// no in-process core, injected store or provider substitution participates.
func TestCertificateRealCoordinatorCLICredentialReadback(t *testing.T) {
	dataRoot := t.TempDir()
	store, err := secret.Open(dataRoot)
	must(t, err)
	if _, err := store.Get("account.credential-index"); !errors.Is(err, secret.ErrMissing) {
		t.Fatal("certificate CLI acceptance requires an empty isolated Secret Service")
	}
	f := newFixture(t)
	due := setCoordinatorCertificateTime(t, f, 2*24*time.Hour)
	serviceID := f.authority.ServiceID
	credentialKey := "account.credential." + serviceID
	metadataKey := "account.certificate." + serviceID
	for _, key := range []string{credentialKey, metadataKey} {
		if _, err := store.Get(key); !errors.Is(err, secret.ErrMissing) {
			t.Fatal("random test service already has a secret record")
		}
	}
	t.Cleanup(func() { cleanupCertificateCLISecrets(t, store, serviceID) })

	binary := cliBinary(t)
	state := stateDirectoryForCLI(t)
	catalogRoot := t.TempDir()
	rootsPath := filepath.Join(t.TempDir(), "coordinator-roots.pem")
	writeRootsPEM(t, rootsPath, f.root)
	arguments := []string{"serve", "--state", state, "--data", dataRoot, "--catalog", catalogRoot, "--roots", rootsPath}
	ctx, cancel := context.WithTimeout(f.ctx, 90*time.Second)
	defer cancel()
	stop := startHeadlessCoreWithArguments(t, binary, arguments...)
	t.Cleanup(stop)
	parent := certificateCLIConnect(t, ctx, state)
	t.Cleanup(func() { parent.Close() })
	configureCoreService(t, ctx, parent, f)

	renewed := certificateCLIMaintain(t, ctx, parent, f, due, f.config[0].Pin.Pair.NetworkID)
	if bytes.Equal(renewed.Certificate, due.Certificate) {
		t.Fatal("production CLI did not renew the certificate in the seven-day window")
	}
	assertCertificateCLICanonical(t, ctx, parent, f, renewed)
	assertCertificateCLIIndexAndMetadata(t, store, serviceID, f.config[0].Pin.Pair.NetworkID)
	assertCertificateBindings(t, f, renewed)
	committed, err := f.client.ReadCertificate(ctx, due.DeviceID, f.config[0].Private, f.authority)
	must(t, err)
	if !reflect.DeepEqual(committed, renewed) {
		t.Fatal("OS-backed canonical credential differs from the real coordinator readback")
	}

	parent.Close()
	stop()
	restarted := startHeadlessCoreWithArguments(t, binary, arguments...)
	t.Cleanup(restarted)
	parent = certificateCLIConnect(t, ctx, state)
	// No service.configure or device.restore is sent after process restart. The
	// production headless startup must discover its OS-backed original identity.
	stale := certificateCLIMaintain(t, ctx, parent, f, due, "")
	if !reflect.DeepEqual(stale, renewed) {
		t.Fatal("stale shell downgraded the canonical certificate after CLI restart")
	}
	assertCertificateCLICanonical(t, ctx, parent, f, renewed)
	assertCertificateCLIIndexAndMetadata(t, store, serviceID, f.config[0].Pin.Pair.NetworkID)
	current, err := f.client.ReadCertificate(ctx, due.DeviceID, f.config[0].Private, f.authority)
	must(t, err)
	if !reflect.DeepEqual(current, committed) {
		t.Fatal("CLI restart changed coordinator identity or issued another certificate")
	}
	t.Log("production CLI renewed and read back the OS credential; restart preserved the original service, device, key, network and certificate")
}

func certificateCLIConnect(t *testing.T, ctx context.Context, state string) *localrpc.Peer {
	t.Helper()
	record, err := localrpc.ReadEndpointRecord(filepath.Join(state, localrpc.EndpointFileName))
	must(t, err)
	connection, err := localrpc.Connect(ctx, record.Socket, record.Secret)
	must(t, err)
	return localrpc.New(ctx, connection, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_shell_callback")
	})
}

func certificateCLIShellCall(t *testing.T, ctx context.Context, parent *localrpc.Peer, method string, request any) json.RawMessage {
	t.Helper()
	entry, exists := localrpc.Lookup(method)
	if !exists || entry.Role != localrpc.RoleShell {
		t.Fatal("certificate test attempted an unpublished shell operation")
	}
	return callCore(t, ctx, parent, method, request)
}

func certificateCLIMaintain(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *realCoordinator, device controlplane.Device, networkID string) controlplane.Device {
	t.Helper()
	data := map[string]any{"device": device, "privateKey": f.config[0].Private}
	if networkID != "" {
		data["networkId"] = networkID
	}
	payload := certificateCLIShellCall(t, ctx, parent, "device.certificate", map[string]any{"serviceId": f.authority.ServiceID, "data": data})
	var response struct {
		DeviceID    string `json:"deviceId"`
		PublicKey   []byte `json:"publicKey"`
		Certificate []byte `json:"certificate"`
	}
	must(t, protocol.DecodeExact(payload, &response))
	if response.DeviceID != device.DeviceID || !bytes.Equal(response.PublicKey, device.PublicKey) {
		t.Fatal("production certificate RPC changed original public identity")
	}
	device.Certificate = response.Certificate
	return device
}

func assertCertificateCLICanonical(t *testing.T, ctx context.Context, parent *localrpc.Peer, f *realCoordinator, device controlplane.Device) {
	t.Helper()
	payload := certificateCLIShellCall(t, ctx, parent, "core.secret_get", map[string]string{"key": "account.credential." + f.authority.ServiceID})
	var response struct {
		Value string `json:"value"`
	}
	must(t, protocol.DecodeExact(payload, &response))
	data, err := base64.StdEncoding.DecodeString(response.Value)
	must(t, err)
	defer clear(data)
	var stored struct {
		Version     int                    `json:"version"`
		ServiceID   string                 `json:"serviceId"`
		Endpoints   controlplane.Endpoints `json:"endpoints"`
		ServiceKey  []byte                 `json:"serviceKey"`
		DeviceID    string                 `json:"deviceId"`
		UserID      string                 `json:"userId"`
		Name        string                 `json:"name"`
		PublicKey   []byte                 `json:"publicKey"`
		Certificate []byte                 `json:"certificate"`
		PrivateKey  []byte                 `json:"privateKey"`
	}
	must(t, protocol.DecodeExact(data, &stored))
	defer clear(stored.PrivateKey)
	if stored.Version != 1 || stored.ServiceID != f.authority.ServiceID || stored.Endpoints != f.endpoints || !bytes.Equal(stored.ServiceKey, f.authority.PublicKey) || stored.DeviceID != device.DeviceID || stored.UserID != device.UserID || stored.Name != device.Name || !bytes.Equal(stored.PublicKey, device.PublicKey) || !bytes.Equal(stored.Certificate, device.Certificate) || !bytes.Equal(stored.PrivateKey, f.config[0].Private) {
		t.Fatal("production OS credential readback did not preserve every canonical field")
	}
}

func assertCertificateCLIIndexAndMetadata(t *testing.T, store secret.Store, serviceID, networkID string) {
	t.Helper()
	data, err := store.Get("account.credential-index")
	must(t, err)
	var index struct {
		Version  int      `json:"version"`
		Services []string `json:"services"`
	}
	must(t, protocol.DecodeExact(data, &index))
	if index.Version != 1 || len(index.Services) != 1 || index.Services[0] != serviceID {
		t.Fatal("isolated OS credential index did not contain exactly the original service")
	}
	data, err = store.Get("account.certificate." + serviceID)
	must(t, err)
	var metadata struct {
		Version          int    `json:"version"`
		NetworkID        string `json:"networkId"`
		PendingRequestID string `json:"pendingRequestId"`
	}
	must(t, protocol.DecodeExact(data, &metadata))
	if metadata.Version != 1 || metadata.NetworkID != networkID || metadata.PendingRequestID != "" {
		t.Fatal("OS certificate metadata lost explicit network scope or retained an issuance owner")
	}
}

func cleanupCertificateCLISecrets(t *testing.T, store secret.Store, serviceID string) {
	t.Helper()
	for _, key := range []string{"account.credential." + serviceID, "account.certificate." + serviceID} {
		if err := store.Delete(key); err != nil {
			t.Errorf("remove this test's scoped OS credential: %v", err)
		}
		if _, err := store.Get(key); !errors.Is(err, secret.ErrMissing) {
			t.Error("deleted test OS credential remained readable")
		}
	}
	data, err := store.Get("account.credential-index")
	if errors.Is(err, secret.ErrMissing) {
		return
	}
	var index struct {
		Version  int      `json:"version"`
		Services []string `json:"services"`
	}
	if err != nil || protocol.DecodeExact(data, &index) != nil || index.Version != 1 || len(index.Services) != 1 || index.Services[0] != serviceID {
		t.Error("test OS credential index contains unexpected ownership; refused deletion")
		return
	}
	if err := store.Delete("account.credential-index"); err != nil {
		t.Errorf("remove this test's exclusive OS credential index: %v", err)
	}
	if _, err := store.Get("account.credential-index"); !errors.Is(err, secret.ErrMissing) {
		t.Error("deleted test OS credential index remained readable")
	}
}
