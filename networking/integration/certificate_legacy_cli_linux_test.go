//go:build linux

package integration

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

type certificateLegacyCLI struct {
	f                  *realCoordinator
	ctx                context.Context
	store              secret.Store
	parent             *localrpc.Peer
	binary, state      string
	arguments          []string
	stop               func()
	expired            controlplane.Device
	network, unbound   controlplane.Network
	account            controlplane.UserSession
	username, password string
}

// These are production dshkerd/Secret Service/coordinator processes. The only
// seeded state is the exact historical version-1 OS credential, without a
// network field, and optionally the historical empty certificate sidecar.
func TestCertificateRealCoordinatorCLILegacyRecovery(t *testing.T) {
	for _, metadataExists := range []bool{false, true} {
		name := "missing-metadata"
		if metadataExists {
			name = "empty-network-metadata"
		}
		t.Run(name, func(t *testing.T) {
			legacy := newCertificateLegacyCLI(t, metadataExists)
			ownership := certificateLegacyOwnership(t, legacy.f)
			before := certificateLegacyIssuanceCounts(t, legacy.f)
			session := certificateLegacyLogin(t, legacy)
			for _, token := range []string{"", session.Token} {
				request := certificateLegacyRequest(legacy, "", token)
				if code := refusalOf(t, legacy.ctx, legacy.parent, "device.certificate", request); code != "p2p.certificate_recovery_required" {
					t.Fatalf("new login without an exact network scope refused with %q", code)
				}
				assertCertificateCLICanonical(t, legacy.ctx, legacy.parent, legacy.f, legacy.expired)
				assertCertificateCLIIndexAndMetadata(t, legacy.store, legacy.f.authority.ServiceID, "")
			}
			assertCertificateLegacyServer(t, legacy, legacy.expired, ownership)
			if certificateLegacyIssuanceCounts(t, legacy.f) != before {
				t.Fatal("unscoped recovery minted or consumed an enrollment grant or issued a certificate")
			}
			// Setup, login and refusal readbacks share the coordinator's IP
			// budget. Give fresh selection and its recovery transaction their own
			// window; waiting only after recovery cannot admit those requests.
			waitForRequestBudget()
			certificateLegacyVerifySelection(t, legacy, session)
			recovered := certificateLegacyRecover(t, legacy, session.Token)
			waitForRequestBudget()
			assertCertificateLegacyServer(t, legacy, recovered, ownership)
			assertCertificateCLICanonical(t, legacy.ctx, legacy.parent, legacy.f, recovered)
			assertCertificateCLIIndexAndMetadata(t, legacy.store, legacy.f.authority.ServiceID, legacy.network.NetworkID)
			after := certificateLegacyIssuanceCounts(t, legacy.f)
			if after.Grants != before.Grants+1 || after.Used != before.Used+1 || after.Renewals != before.Renewals+1 {
				t.Fatal("exact legacy recovery did not issue and consume exactly one grant for one certificate")
			}
			persisted := certificateLegacyOSReadback(t, legacy)
			issuance := certificateLegacyIssuanceRows(t, legacy.f)
			legacy.parent.Close()
			legacy.stop()
			legacy.f.server.stop(t, false)
			legacy.f.startServer(t)
			legacy.stop = startHeadlessCoreWithArguments(t, legacy.binary, legacy.arguments...)
			legacy.parent = certificateCLIConnect(t, legacy.ctx, legacy.state)
			// Startup receives no configure, restore, login, network or token.
			// The old shell still owns only its original expired certificate.
			for range 2 {
				actual := certificateCLIMaintain(t, legacy.ctx, legacy.parent, legacy.f, legacy.expired, "")
				if !reflect.DeepEqual(actual, recovered) {
					t.Fatal("stale legacy shell downgraded the recovered canonical credential after restart")
				}
			}
			assertCertificateCLICanonical(t, legacy.ctx, legacy.parent, legacy.f, recovered)
			assertCertificateCLIIndexAndMetadata(t, legacy.store, legacy.f.authority.ServiceID, legacy.network.NetworkID)
			assertCertificateLegacyServer(t, legacy, recovered, ownership)
			if !reflect.DeepEqual(certificateLegacyOSReadback(t, legacy), persisted) || !reflect.DeepEqual(certificateLegacyIssuanceRows(t, legacy.f), issuance) {
				t.Fatal("restart or repeated stale-shell requests changed OS records, issuance or grant consumption")
			}
			current, err := legacy.f.client.CurrentUser(legacy.ctx, session.Token)
			must(t, err)
			if current != session.User {
				t.Fatal("legacy recovery changed the freshly authenticated account")
			}
		})
	}
}

func TestCertificateRealCoordinatorCLILegacyScopeRefusals(t *testing.T) {
	for _, scope := range []string{"foreign-account", "unbound-network", "missing-network"} {
		t.Run(scope, func(t *testing.T) {
			legacy := newCertificateLegacyCLI(t, false)
			session := certificateLegacyLogin(t, legacy)
			networkID, token := legacy.network.NetworkID, session.Token
			switch scope {
			case "foreign-account":
				token = legacy.f.userSession.Token
			case "unbound-network":
				networkID = legacy.unbound.NetworkID
			case "missing-network":
				networkID = protocol.NewID()
			}
			ownership := certificateLegacyOwnership(t, legacy.f)
			before := certificateLegacyIssuanceCounts(t, legacy.f)
			request := certificateLegacyRequest(legacy, networkID, token)
			if code := refusalOf(t, legacy.ctx, legacy.parent, "device.certificate", request); code != "p2p.certificate_recovery_forbidden" {
				certificateLegacyDiagnoseRefusal(t, legacy, networkID, token, before)
				t.Fatalf("unauthorized exact scope refused with %q", code)
			}
			assertCertificateCLICanonical(t, legacy.ctx, legacy.parent, legacy.f, legacy.expired)
			assertCertificateLegacyServer(t, legacy, legacy.expired, ownership)
			after := certificateLegacyIssuanceCounts(t, legacy.f)
			expectedGrants := before.Grants
			if scope == "unbound-network" {
				expectedGrants++ // The real grant is refused by recovery before consumption.
			}
			if after.Grants != expectedGrants || after.Used != before.Used || after.Renewals != before.Renewals {
				t.Fatal("rejected scope consumed a grant, issued a certificate or produced an unexpected grant")
			}
			current, err := legacy.f.client.CurrentUser(legacy.ctx, session.Token)
			must(t, err)
			if current != session.User {
				t.Fatal("recovery rejection invalidated an unrelated valid login")
			}
		})
	}
}

func newCertificateLegacyCLI(t *testing.T, metadataExists bool) *certificateLegacyCLI {
	t.Helper()
	dataRoot := t.TempDir()
	store, err := secret.Open(dataRoot)
	must(t, err)
	if _, err := store.Get("account.credential-index"); !errors.Is(err, secret.ErrMissing) {
		t.Fatal("legacy CLI acceptance requires an empty isolated Secret Service")
	}
	f := newFixture(t)
	legacy := &certificateLegacyCLI{f: f, store: store, username: "legacy-login@test.local", password: protocol.NewID() + protocol.NewID()}
	user, err := f.client.Register(f.ctx, legacy.username, legacy.password)
	must(t, err)
	legacy.account, err = f.client.Login(f.ctx, legacy.username, legacy.password)
	must(t, err)
	if legacy.account.User != user || user.UserID == f.config[0].Device.UserID {
		t.Fatal("legacy process setup must distinguish the login account from the original device owner")
	}
	legacy.unbound, err = f.client.CreateNetwork(f.ctx, legacy.account.Token, "existing-unbound-network")
	must(t, err)
	legacy.network, err = f.client.CreateNetwork(f.ctx, legacy.account.Token, "existing-selected-network")
	must(t, err)
	csr, err := controlplane.DeviceCSR(f.config[0].Private)
	must(t, err)
	joined, err := f.client.JoinNetwork(f.ctx, controlplane.NetworkJoin{RequestID: protocol.NewID(), NetworkID: legacy.network.NetworkID, CSR: csr, Name: f.config[0].Device.Name})
	must(t, err)
	if joined.DeviceID != f.config[0].Device.DeviceID || !bytes.Equal(joined.PublicKey, f.config[0].Device.PublicKey) || !bytes.Equal(joined.Certificate, f.config[0].Device.Certificate) {
		t.Fatal("binding the existing device changed its identity or certificate")
	}
	legacy.expired = setCoordinatorCertificateTime(t, f, -10*time.Second)
	leaf, err := f.client.ValidateDevice(legacy.expired, f.config[0].Private, f.authority, true)
	must(t, err)
	if time.Now().Before(leaf.NotAfter) {
		t.Fatal("legacy shell certificate must already be expired")
	}
	seedCertificateLegacyOS(t, legacy, metadataExists)
	t.Cleanup(func() { cleanupCertificateCLISecrets(t, store, f.authority.ServiceID) })
	legacy.binary, legacy.state = cliBinary(t), stateDirectoryForCLI(t)
	rootsPath := filepath.Join(t.TempDir(), "coordinator-roots.pem")
	writeRootsPEM(t, rootsPath, f.root)
	catalogRoot := t.TempDir()
	catalogStore, err := catalog.Open(catalogRoot)
	must(t, err)
	enabledCatalog, err := catalogStore.Enable()
	must(t, err)
	enabledCatalog.Record.Services = []catalog.Service{integrationCatalogService(f)}
	_, err = catalogStore.Commit(enabledCatalog.Revision, enabledCatalog.Record)
	must(t, err)
	legacy.arguments = []string{"serve", "--state", legacy.state, "--data", dataRoot, "--catalog", catalogRoot, "--roots", rootsPath}
	ctx, cancel := context.WithTimeout(f.ctx, 90*time.Second)
	legacy.ctx = ctx
	t.Cleanup(cancel)
	legacy.stop = startHeadlessCoreWithArguments(t, legacy.binary, legacy.arguments...)
	t.Cleanup(func() { legacy.stop() })
	legacy.parent = certificateCLIConnect(t, ctx, legacy.state)
	t.Cleanup(func() { legacy.parent.Close() })
	assertCertificateCLICanonical(t, ctx, legacy.parent, f, legacy.expired)
	return legacy
}

func seedCertificateLegacyOS(t *testing.T, legacy *certificateLegacyCLI, metadataExists bool) {
	t.Helper()
	f, device := legacy.f, legacy.expired
	record := map[string]any{"version": 1, "serviceId": f.authority.ServiceID, "endpoints": f.endpoints, "serviceKey": f.authority.PublicKey, "deviceId": device.DeviceID, "userId": device.UserID, "name": device.Name, "publicKey": device.PublicKey, "certificate": device.Certificate, "privateKey": f.config[0].Private}
	data, err := json.Marshal(record)
	must(t, err)
	defer clear(data)
	serviceID := f.authority.ServiceID
	for _, key := range []string{"account.credential." + serviceID, "account.certificate." + serviceID} {
		if _, err := legacy.store.Get(key); !errors.Is(err, secret.ErrMissing) {
			t.Fatal("random legacy test service already has an OS secret")
		}
	}
	must(t, legacy.store.Set("account.credential."+serviceID, data))
	index, err := json.Marshal(map[string]any{"version": 1, "services": []string{serviceID}})
	must(t, err)
	must(t, legacy.store.Set("account.credential-index", index))
	if metadataExists {
		must(t, legacy.store.Set("account.certificate."+serviceID, []byte(`{"version":1,"networkId":"","pendingRequestId":""}`)))
	}
}

func certificateLegacyLogin(t *testing.T, legacy *certificateLegacyCLI) controlplane.UserSession {
	t.Helper()
	payload := certificateCLIShellCall(t, legacy.ctx, legacy.parent, "user.login", map[string]any{"serviceId": legacy.f.authority.ServiceID, "data": map[string]string{"username": legacy.username, "password": legacy.password}})
	var session controlplane.UserSession
	must(t, protocol.DecodeExact(payload, &session))
	if session.User != legacy.account.User || len(session.Token) != 64 || session.Token == legacy.account.Token || session.ExpiresAt <= time.Now().Unix() {
		t.Fatal("real login did not issue a fresh valid session for the existing linked account")
	}
	return session
}

func certificateLegacyVerifySelection(t *testing.T, legacy *certificateLegacyCLI, session controlplane.UserSession) {
	t.Helper()
	call := func(method string, data any) json.RawMessage {
		return certificateCLIShellCall(t, legacy.ctx, legacy.parent, method, map[string]any{"serviceId": legacy.f.authority.ServiceID, "data": data})
	}
	var user controlplane.User
	must(t, protocol.DecodeExact(call("user.current", map[string]string{"token": session.Token}), &user))
	if user != session.User || user.UserID == legacy.expired.UserID {
		t.Fatal("fresh account readback lost the distinct login and original device owners")
	}
	var networks []controlplane.Network
	must(t, json.Unmarshal(call("networks.list", map[string]string{"token": session.Token}), &networks))
	selected := false
	for _, network := range networks {
		if network.NetworkID == legacy.network.NetworkID {
			selected = network == legacy.network && network.UserID == user.UserID
		}
	}
	if !selected || len(networks) != 2 {
		t.Fatal("fresh directory did not verify the exact existing selected network among both account networks")
	}
	var members []controlplane.DeviceEntry
	must(t, json.Unmarshal(call("networks.devices", map[string]string{"token": session.Token, "networkId": legacy.network.NetworkID}), &members))
	if len(members) != 1 || members[0].DeviceID != legacy.expired.DeviceID || members[0].Name != legacy.expired.Name {
		t.Fatal("fresh directory did not verify the original device's existing network binding")
	}
}

func certificateLegacyRequest(legacy *certificateLegacyCLI, networkID, token string) any {
	data := map[string]any{"device": legacy.expired, "privateKey": legacy.f.config[0].Private}
	if networkID != "" {
		data["networkId"] = networkID
	}
	if token != "" {
		data["token"] = token
	}
	return map[string]any{"serviceId": legacy.f.authority.ServiceID, "data": data}
}

func certificateLegacyRecover(t *testing.T, legacy *certificateLegacyCLI, token string) controlplane.Device {
	t.Helper()
	payload := certificateCLIShellCall(t, legacy.ctx, legacy.parent, "device.certificate", certificateLegacyRequest(legacy, legacy.network.NetworkID, token))
	var response struct {
		DeviceID    string `json:"deviceId"`
		PublicKey   []byte `json:"publicKey"`
		Certificate []byte `json:"certificate"`
	}
	must(t, protocol.DecodeExact(payload, &response))
	device := legacy.expired
	if response.DeviceID != device.DeviceID || !bytes.Equal(response.PublicKey, device.PublicKey) || bytes.Equal(response.Certificate, device.Certificate) {
		t.Fatal("scoped recovery failed to replace only the original device certificate")
	}
	device.Certificate = response.Certificate
	_, err := legacy.f.client.ValidateDevice(device, legacy.f.config[0].Private, legacy.f.authority, false)
	must(t, err)
	assertCertificateBindings(t, legacy.f, device)
	return device
}

func assertCertificateLegacyServer(t *testing.T, legacy *certificateLegacyCLI, device controlplane.Device, ownership map[string]string) {
	t.Helper()
	current, err := legacy.f.client.ReadCertificate(legacy.ctx, device.DeviceID, legacy.f.config[0].Private, legacy.f.authority)
	must(t, err)
	if !reflect.DeepEqual(current, device) || !reflect.DeepEqual(certificateLegacyOwnership(t, legacy.f), ownership) {
		t.Fatal("certificate lifecycle changed server device identity, users, networks, bindings or pair revisions")
	}
}

func certificateLegacyOSReadback(t *testing.T, legacy *certificateLegacyCLI) map[string][]byte {
	t.Helper()
	values := make(map[string][]byte)
	for _, key := range []string{"account.credential." + legacy.f.authority.ServiceID, "account.certificate." + legacy.f.authority.ServiceID, "account.credential-index"} {
		payload := certificateCLIShellCall(t, legacy.ctx, legacy.parent, "core.secret_get", map[string]string{"key": key})
		var response struct {
			Value string `json:"value"`
		}
		must(t, protocol.DecodeExact(payload, &response))
		data, err := base64.StdEncoding.DecodeString(response.Value)
		must(t, err)
		stored, err := legacy.store.Get(key)
		must(t, err)
		if !bytes.Equal(data, stored) {
			t.Fatal("core and OS provider readbacks differ for", key)
		}
		values[key] = data
		clear(stored)
	}
	t.Cleanup(func() {
		for _, value := range values {
			clear(value)
		}
	})
	return values
}

func certificateLegacyOwnership(t *testing.T, f *realCoordinator) map[string]string {
	t.Helper()
	queries := map[string]string{
		"users":        "SELECT id,email,disabled FROM users ORDER BY id",
		"devices":      "SELECT id,user_id,hex(public_key) AS public_key,name,revoked,request_id FROM devices ORDER BY id",
		"networks":     "SELECT id,user_id,name,deleted,max_devices FROM networks ORDER BY id",
		"device_users": "SELECT device_id,user_id FROM device_users ORDER BY device_id,user_id",
		"bindings":     "SELECT network_id,device_id,active FROM bindings ORDER BY network_id,device_id",
		"pairs":        "SELECT id,network_id,initiator,target,state,expires,revision FROM pairs ORDER BY id",
	}
	rows := make(map[string]string, len(queries))
	for name, query := range queries {
		rows[name] = string(certificateLegacyQuery(t, f, query))
	}
	return rows
}

type certificateLegacyIssuance struct {
	Grants   int `json:"grants"`
	Used     int `json:"used"`
	Renewals int `json:"renewals"`
}

func certificateLegacyIssuanceCounts(t *testing.T, f *realCoordinator) certificateLegacyIssuance {
	t.Helper()
	query := "SELECT (SELECT count(*) FROM tokens) AS grants,(SELECT coalesce(sum(used),0) FROM tokens) AS used,(SELECT count(*) FROM renewals) AS renewals"
	var rows []certificateLegacyIssuance
	must(t, json.Unmarshal(certificateLegacyQuery(t, f, query), &rows))
	if len(rows) != 1 {
		t.Fatal("isolated coordinator did not return exactly one issuance accounting row")
	}
	return rows[0]
}

func certificateLegacyIssuanceRows(t *testing.T, f *realCoordinator) map[string]string {
	t.Helper()
	return map[string]string{
		"tokens":   string(certificateLegacyQuery(t, f, "SELECT hash,user_id,network_id,expires,used FROM tokens ORDER BY hash")),
		"renewals": string(certificateLegacyQuery(t, f, "SELECT device_id,request_id,hex(certificate) AS certificate FROM renewals ORDER BY device_id,request_id")),
	}
}

func certificateLegacyQuery(t *testing.T, f *realCoordinator, query string) []byte {
	t.Helper()
	output, err := certificateLegacyQueryResult(f, query)
	must(t, err)
	return output
}

func certificateLegacyQueryResult(f *realCoordinator, query string) ([]byte, error) {
	data, err := os.ReadFile(f.configPath)
	if err != nil {
		return nil, err
	}
	var config map[string]string
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(config["databasePath"]) {
		return nil, errors.New("isolated coordinator database path is absent or relative")
	}
	command := exec.CommandContext(f.ctx, "sqlite3", "-readonly", "-batch", "-json", config["databasePath"], query)
	return command.Output()
}

// Run only after the original refusal assertion has failed. Diagnostics never
// retry the RPC, accept another code or change the successful execution path.
func certificateLegacyDiagnoseRefusal(t *testing.T, legacy *certificateLegacyCLI, networkID, token string, before certificateLegacyIssuance) {
	t.Helper()
	certificateLegacyDiagnoseCanonical(t, legacy)
	certificateLegacyDiagnoseMetadata(t, legacy, networkID)
	current, err := legacy.f.client.ReadCertificate(legacy.ctx, legacy.expired.DeviceID, legacy.f.config[0].Private, legacy.f.authority)
	if err != nil {
		t.Logf("legacy refusal diagnostic: signed readback error=%v", err)
	} else {
		t.Logf("legacy refusal diagnostic: signed readback original_identity=%t certificate_unchanged=%t", current.DeviceID == legacy.expired.DeviceID && current.UserID == legacy.expired.UserID && current.Name == legacy.expired.Name && bytes.Equal(current.PublicKey, legacy.expired.PublicKey), bytes.Equal(current.Certificate, legacy.expired.Certificate))
		certificateLegacyDiagnoseLeaf(t, "server", current.Certificate)
	}
	certificateLegacyDiagnoseCounts(t, legacy, "after-original-rpc", before)
	// Only the owned but unbound network can reach the real recovery endpoint;
	// foreign and missing networks are already refused during grant admission.
	if networkID == legacy.unbound.NetworkID {
		certificateLegacyDiagnoseRecoveryHTTP(t, legacy, networkID, token)
		certificateLegacyDiagnoseCounts(t, legacy, "after-direct-http-probe", before)
	}
}

func certificateLegacyDiagnosticRecord(t *testing.T, legacy *certificateLegacyCLI, kind, key string) ([]byte, bool) {
	t.Helper()
	data, err := legacy.store.Get(key)
	if err != nil {
		t.Logf("legacy refusal diagnostic: OS %s read error=%v", kind, err)
		return nil, false
	}
	payload, err := legacy.parent.Call(legacy.ctx, "core.secret_get", map[string]string{"key": key})
	if err != nil {
		t.Logf("legacy refusal diagnostic: core %s read error=%v", kind, err)
		return data, true
	}
	var response struct {
		Value string `json:"value"`
	}
	if err := protocol.DecodeExact(payload, &response); err != nil {
		t.Logf("legacy refusal diagnostic: core %s response_schema_valid=false", kind)
		return data, true
	}
	readback, err := base64.StdEncoding.DecodeString(response.Value)
	defer clear(readback)
	t.Logf("legacy refusal diagnostic: %s core_OS_bytes_equal=%t core_base64_valid=%t", kind, bytes.Equal(data, readback), err == nil)
	return data, true
}

func certificateLegacyDiagnoseCanonical(t *testing.T, legacy *certificateLegacyCLI) {
	t.Helper()
	data, ok := certificateLegacyDiagnosticRecord(t, legacy, "canonical", "account.credential."+legacy.f.authority.ServiceID)
	if !ok {
		return
	}
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
	err := protocol.DecodeExact(data, &stored)
	defer clear(stored.PrivateKey)
	identity := stored.Version == 1 && stored.ServiceID == legacy.f.authority.ServiceID && stored.Endpoints == legacy.f.endpoints && bytes.Equal(stored.ServiceKey, legacy.f.authority.PublicKey) && stored.DeviceID == legacy.expired.DeviceID && stored.UserID == legacy.expired.UserID && stored.Name == legacy.expired.Name && bytes.Equal(stored.PublicKey, legacy.expired.PublicKey) && bytes.Equal(stored.PrivateKey, legacy.f.config[0].Private)
	t.Logf("legacy refusal diagnostic: canonical schema_valid=%t original_identity=%t certificate_unchanged=%t", err == nil, identity, bytes.Equal(stored.Certificate, legacy.expired.Certificate))
	certificateLegacyDiagnoseLeaf(t, "canonical", stored.Certificate)
}

func certificateLegacyDiagnoseMetadata(t *testing.T, legacy *certificateLegacyCLI, networkID string) {
	t.Helper()
	data, ok := certificateLegacyDiagnosticRecord(t, legacy, "index", "account.credential-index")
	if ok {
		defer clear(data)
		var index struct {
			Version  int      `json:"version"`
			Services []string `json:"services"`
		}
		err := protocol.DecodeExact(data, &index)
		t.Logf("legacy refusal diagnostic: index schema_valid=%t original_service_only=%t", err == nil, index.Version == 1 && len(index.Services) == 1 && index.Services[0] == legacy.f.authority.ServiceID)
	}
	data, ok = certificateLegacyDiagnosticRecord(t, legacy, "sidecar", "account.certificate."+legacy.f.authority.ServiceID)
	if !ok {
		return
	}
	defer clear(data)
	var metadata struct {
		Version          int    `json:"version"`
		NetworkID        string `json:"networkId"`
		PendingRequestID string `json:"pendingRequestId"`
	}
	err := protocol.DecodeExact(data, &metadata)
	t.Logf("legacy refusal diagnostic: sidecar schema_valid=%t version_valid=%t network_empty=%t network_matches_request=%t pending_present=%t pending_valid=%t", err == nil, metadata.Version == 1, metadata.NetworkID == "", metadata.NetworkID == networkID, metadata.PendingRequestID != "", metadata.PendingRequestID == "" || protocol.ValidID(metadata.PendingRequestID))
}

func certificateLegacyDiagnoseLeaf(t *testing.T, source string, data []byte) {
	t.Helper()
	leaf, err := x509.ParseCertificate(data)
	if err != nil {
		t.Logf("legacy refusal diagnostic: %s leaf_parse_valid=false", source)
		return
	}
	t.Logf("legacy refusal diagnostic: %s leaf_not_before=%s leaf_not_after=%s observed_at=%s", source, leaf.NotBefore.UTC().Format(time.RFC3339Nano), leaf.NotAfter.UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano))
}

func certificateLegacyDiagnoseCounts(t *testing.T, legacy *certificateLegacyCLI, phase string, before certificateLegacyIssuance) {
	t.Helper()
	query := "SELECT (SELECT count(*) FROM tokens) AS grants,(SELECT coalesce(sum(used),0) FROM tokens) AS used,(SELECT count(*) FROM renewals) AS renewals"
	data, err := certificateLegacyQueryResult(legacy.f, query)
	if err != nil {
		t.Logf("legacy refusal diagnostic: phase=%s issuance_read error=%v", phase, err)
		return
	}
	var after []certificateLegacyIssuance
	if json.Unmarshal(data, &after) != nil || len(after) != 1 {
		t.Logf("legacy refusal diagnostic: phase=%s issuance_schema_valid=false", phase)
		return
	}
	t.Logf("legacy refusal diagnostic: phase=%s before=%+v after=%+v", phase, before, after[0])
}

func certificateLegacyDiagnoseRecoveryHTTP(t *testing.T, legacy *certificateLegacyCLI, networkID, token string) {
	t.Helper()
	grant, err := legacy.f.client.EnrollmentToken(legacy.ctx, token, networkID)
	if err != nil {
		t.Logf("legacy refusal diagnostic: direct recovery grant error=%v", err)
		return
	}
	csr, err := controlplane.DeviceCSR(legacy.f.config[0].Private)
	if err != nil {
		t.Logf("legacy refusal diagnostic: direct recovery CSR construction failed")
		return
	}
	body, err := json.Marshal(map[string]string{"deviceId": legacy.expired.DeviceID, "requestId": protocol.NewID(), "csr": csr, "token": grant.Token})
	if err != nil {
		t.Logf("legacy refusal diagnostic: direct recovery request encoding failed")
		return
	}
	defer clear(body)
	root, err := x509.ParseCertificate(legacy.f.root)
	if err != nil {
		t.Logf("legacy refusal diagnostic: direct recovery TLS root parsing failed")
		return
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}, MaxResponseHeaderBytes: 16 * 1024, IdleConnTimeout: 30 * time.Second}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(legacy.ctx, http.MethodPost, legacy.f.endpoints.HTTPSOrigin+"/v1/recover-certificate", bytes.NewReader(body))
	if err != nil {
		t.Logf("legacy refusal diagnostic: direct recovery request construction failed")
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Logf("legacy refusal diagnostic: direct recovery transport error=%v", err)
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, protocol.MaxControlBytes+1))
	defer clear(data)
	if err != nil || len(data) > protocol.MaxControlBytes {
		t.Logf("legacy refusal diagnostic: direct recovery status=%d protocol=%s body_read_valid=false transport_error=%v", response.StatusCode, response.Proto, err)
		return
	}
	var failure struct {
		Code string `json:"code"`
	}
	validCode := protocol.DecodeExact(data, &failure) == nil && certificateLegacyDiagnosticCode(failure.Code)
	if !validCode {
		t.Logf("legacy refusal diagnostic: direct recovery status=%d protocol=%s refusal_schema_valid=false", response.StatusCode, response.Proto)
		return
	}
	t.Logf("legacy refusal diagnostic: direct recovery status=%d protocol=%s code=%s", response.StatusCode, response.Proto, failure.Code)
}

func certificateLegacyDiagnosticCode(code string) bool {
	if len(code) < len("p2p.a") || len(code) > 80 || code[:4] != "p2p." {
		return false
	}
	for _, character := range code[4:] {
		if character != '_' && (character < 'a' || character > 'z') {
			return false
		}
	}
	return true
}
