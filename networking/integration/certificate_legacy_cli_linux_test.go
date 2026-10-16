//go:build linux

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

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
			certificateLegacyVerifySelection(t, legacy, session)
			recovered := certificateLegacyRecover(t, legacy, session.Token)
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
	legacy.arguments = []string{"serve", "--state", legacy.state, "--data", dataRoot, "--catalog", t.TempDir(), "--roots", rootsPath}
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
	data, err := os.ReadFile(f.configPath)
	must(t, err)
	var config map[string]string
	must(t, json.Unmarshal(data, &config))
	command := exec.CommandContext(f.ctx, "sqlite3", "-readonly", "-batch", "-json", config["databasePath"], query)
	output, err := command.Output()
	must(t, err)
	return output
}
