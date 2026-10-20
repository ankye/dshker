package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/ankye/dshker/networking/internal/secret"
)

// These stores exist only in the test composition. macOS ignores dataRoot when
// opening Keychain, so launching dshkerd with a temporary root is not isolation.
type certificateSecrets struct {
	mu     sync.Mutex
	values map[string][]byte
}

func (store *certificateSecrets) Get(key string) ([]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	value, exists := store.values[key]
	if !exists {
		return nil, secret.ErrMissing
	}
	return bytes.Clone(value), nil
}
func (store *certificateSecrets) Set(key string, value []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.values[key] = bytes.Clone(value)
	return nil
}
func (store *certificateSecrets) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.values, key)
	return nil
}

type certificateCallbacks struct {
	mu           sync.Mutex
	runtimeCalls int
}

func (callbacks *certificateCallbacks) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	if strings.HasPrefix(method, "runtime.") {
		callbacks.mu.Lock()
		callbacks.runtimeCalls++
		callbacks.mu.Unlock()
		return nil, errors.New("p2p.unexpected_runtime_request")
	}
	return json.RawMessage(`{}`), nil
}

func certificateCore(t *testing.T, f *realCoordinator, store *certificateSecrets) (*helper.Host, core.Serve, *certificateCallbacks) {
	t.Helper()
	host := helper.New(f.ctx)
	roots := x509.NewCertPool()
	root, err := x509.ParseCertificate(f.root)
	must(t, err)
	roots.AddCert(root)
	host.SetRoots(roots)
	host.SetDeviceKeys(store)
	catalogStore := integrationOpenCatalog(t, f)
	host.SetCatalog(catalogStore)
	callbacks := &certificateCallbacks{}
	host.BindMain(callbacks)
	t.Cleanup(host.Close)
	server := core.Serve{Store: store, Peer: host, Catalog: catalogStore}
	data, err := json.Marshal(map[string]any{"endpoints": f.endpoints, "pinnedKey": f.authority.PublicKey, "telemetry": controlplane.Telemetry{}})
	must(t, err)
	_, err = server.Handle(f.ctx, "service.configure", data)
	must(t, err)
	integrationSelectDirectAccount(t, f.ctx, server, f.authority.ServiceID, f.userSession)
	return host, server, callbacks
}

func certificateRPC(t *testing.T, f *realCoordinator, server core.Serve, device controlplane.Device, networkID, token string) (controlplane.Device, error) {
	t.Helper()
	request := map[string]any{"device": device, "privateKey": f.config[0].Private}
	if networkID != "" {
		request["networkId"] = networkID
	}
	if token != "" {
		request["token"] = token
	}
	data, err := json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": request})
	must(t, err)
	result, err := server.Handle(f.ctx, "device.certificate", data)
	if err != nil {
		return controlplane.Device{}, err
	}
	encoded, err := json.Marshal(result)
	must(t, err)
	var response struct {
		DeviceID    string `json:"deviceId"`
		PublicKey   []byte `json:"publicKey"`
		Certificate []byte `json:"certificate"`
	}
	must(t, protocol.DecodeExact(encoded, &response))
	if response.DeviceID != device.DeviceID || !bytes.Equal(response.PublicKey, device.PublicKey) {
		t.Fatal("certificate RPC changed public identity")
	}
	device.Certificate = response.Certificate
	return device, nil
}

// Re-sign only the isolated server's existing device row to represent clock
// progression. The independent production binary still owns every HTTP route,
// authorization, token, renewal, query, SQLite transaction and restart.
func setCoordinatorCertificateTime(t *testing.T, f *realCoordinator, remaining time.Duration) controlplane.Device {
	t.Helper()
	f.server.stop(t, false)
	data, err := os.ReadFile(f.configPath)
	must(t, err)
	var config map[string]string
	must(t, json.Unmarshal(data, &config))
	encoded, err := os.ReadFile(config["identityKeyPath"])
	must(t, err)
	block, _ := pem.Decode(encoded)
	if block == nil {
		t.Fatal("isolated authority key is missing")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	must(t, err)
	private, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		t.Fatal("isolated authority is not Ed25519")
	}
	ca, err := x509.ParseCertificate(f.authority.Certificate)
	must(t, err)
	device := f.config[0].Device
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	must(t, err)
	leaf := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: device.DeviceID}, NotBefore: ca.NotBefore, NotAfter: time.Now().Add(remaining), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	device.Certificate, err = x509.CreateCertificate(rand.Reader, leaf, ca, f.config[0].Private.Public(), private)
	must(t, err)
	clear(private)
	statement := "UPDATE devices SET certificate=X'" + hex.EncodeToString(device.Certificate) + "' WHERE id='" + device.DeviceID + "'; SELECT changes();"
	command := exec.Command("sqlite3", config["databasePath"])
	command.Stdin = strings.NewReader(statement)
	output, err := command.CombinedOutput()
	must(t, err)
	if strings.TrimSpace(string(output)) != "1" {
		t.Fatal("isolated device clock setup did not update exactly one row")
	}
	f.startServer(t)
	return device
}

func assertCertificateBindings(t *testing.T, f *realCoordinator, device controlplane.Device) {
	t.Helper()
	client, err := f.client.WithDevice(device, f.config[0].Private, f.authority)
	must(t, err)
	defer client.Close()
	identity, err := client.PairIdentity(f.ctx, f.config[0].Pin.Pair.PairID)
	must(t, err)
	if identity.Pair != f.config[0].Pin.Pair || !bytes.Equal(identity.Initiator.PublicKey, f.config[0].Pin.Initiator.PublicKey) || !bytes.Equal(identity.Target.PublicKey, f.config[0].Pin.Target.PublicKey) {
		t.Fatal("certificate maintenance changed pair identity or revision")
	}
	members, err := f.client.NetworkDevices(f.ctx, f.userSession.Token, f.config[0].Pin.Pair.NetworkID)
	must(t, err)
	found := false
	for _, member := range members {
		if member.DeviceID == device.DeviceID {
			found = true
		}
	}
	if !found || len(members) != 2 {
		t.Fatal("certificate maintenance changed network binding or created a device")
	}
}

func TestCertificateRealCoordinatorLifecycle(t *testing.T) {
	t.Run("active-peer-survives-renewal", func(t *testing.T) {
		f := newFixture(t)
		time.Sleep(time.Second)
		ctx, cancel := context.WithTimeout(f.ctx, 45*time.Second)
		defer cancel()
		config := f.config[1]
		f.devices[1].SetAccount(config.Device.UserID)
		// This test HTTP runtime exercises packets without launching DSH.
		runtimeURL, stopRuntime := startStubDSH(t)
		defer stopRuntime()
		var ownerCalls atomic.Int32
		remote, err := peersession.New(ctx, f.devices[1], peersession.Config{Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device, PrivateKey: config.Private, CoreInstanceID: integrationCoreInstanceID(t)}, []controlplane.PairIdentity{}, func(context.Context, string) (runtimebridge.Binding, error) {
			ownerCalls.Add(1)
			return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
		}, func(peersession.State) {})
		must(t, err)
		integrationActivateManager(t, ctx, remote, f, 1)
		defer remote.Close()
		store := &certificateSecrets{values: map[string][]byte{}}
		host, server, callbacks := certificateCore(t, f, store)
		payload, err := json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{"device": f.config[0].Device, "accountUserId": f.userSession.User.UserID, "privateKey": f.config[0].Private, "pins": []controlplane.PairIdentity{}}})
		must(t, err)
		_, err = server.Handle(ctx, "device.restore", payload)
		must(t, err)
		payload, err = json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{"pairId": f.config[1].Device.DeviceID, "generation": 1, "requestWorkbench": true}})
		must(t, err)
		connected, err := server.Handle(ctx, "peer.connect", payload)
		must(t, err)
		encoded, err := json.Marshal(connected)
		must(t, err)
		var active peersession.Connected
		must(t, protocol.DecodeExact(encoded, &active))
		if active.State.Stage != "ready" || active.State.AttemptID == "" {
			t.Fatal("original peer did not establish a data channel", active.State)
		}
		assertLivePeer := func() { must(t, runtimebridge.Probe(ctx, active.URL)) }
		assertLivePeer()
		due := setCoordinatorCertificateTime(t, f, time.Hour)
		// Advance the canonical record as the clock would, keeping the live manager
		// and data channel. Maintenance must change only the client certificate.
		must(t, host.SaveCredential(f.authority.ServiceID, due, f.config[0].Private))
		payload, err = json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{}})
		must(t, err)
		_, err = server.Handle(ctx, "peer.autoconnect_reconcile", payload)
		must(t, err)
		assertLivePeer()
		actual, err := f.client.ReadCertificate(ctx, due.DeviceID, f.config[0].Private, f.authority)
		must(t, err)
		if bytes.Equal(actual.Certificate, due.Certificate) {
			t.Fatal("online maintenance did not renew certificate")
		}
		callbacks.mu.Lock()
		runtimeCalls := callbacks.runtimeCalls
		callbacks.mu.Unlock()
		if runtimeCalls != 0 || ownerCalls.Load() != 1 {
			t.Fatal("certificate renewal started DSH")
		}
	})
	t.Run("original-owner-and-linked-presence", func(t *testing.T) {
		f := newFixture(t)
		time.Sleep(time.Second)
		password := protocol.NewID() + protocol.NewID()
		linked, err := f.client.Register(f.ctx, "linked@test.local", password)
		must(t, err)
		session, err := f.client.Login(f.ctx, linked.Username, password)
		must(t, err)
		network, err := f.client.CreateNetwork(f.ctx, session.Token, "linked-account-network")
		must(t, err)
		csr, err := controlplane.DeviceCSR(f.config[0].Private)
		must(t, err)
		joined, err := f.client.JoinNetwork(f.ctx, controlplane.NetworkJoin{RequestID: protocol.NewID(), NetworkID: network.NetworkID, CSR: csr, Name: f.config[0].Device.Name})
		must(t, err)
		if joined.DeviceID != f.config[0].Device.DeviceID || !bytes.Equal(joined.PublicKey, f.config[0].Device.PublicKey) || !bytes.Equal(joined.Certificate, f.config[0].Device.Certificate) {
			t.Fatal("linked account changed original device identity")
		}
		store := &certificateSecrets{values: map[string][]byte{}}
		host, server, _ := certificateCore(t, f, store)
		owner := f.config[0].Device
		_, err = certificateRPC(t, f, server, owner, f.config[0].Pin.Pair.NetworkID, "")
		must(t, err)
		_, err = certificateRPC(t, f, server, joined, "", "")
		must(t, err)
		// Reproduce the earlier restore version's stored presence-as-owner record.
		key := "account.credential." + f.authority.ServiceID
		data, err := store.Get(key)
		must(t, err)
		var canonical map[string]any
		must(t, json.Unmarshal(data, &canonical))
		canonical["userId"] = session.User.UserID
		data, err = json.Marshal(canonical)
		must(t, err)
		must(t, store.Set(key, data))
		_, err = certificateRPC(t, f, server, owner, "", "")
		must(t, err)
		data, err = store.Get(key)
		must(t, err)
		must(t, json.Unmarshal(data, &canonical))
		if canonical["userId"] != owner.UserID {
			t.Fatal("legacy presence owner did not converge from authenticated query")
		}
		integrationSelectDirectAccount(t, f.ctx, server, f.authority.ServiceID, session)
		payload, err := json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{"device": owner, "accountUserId": session.User.UserID, "privateKey": f.config[0].Private, "pins": []controlplane.PairIdentity{}}})
		must(t, err)
		_, err = server.Handle(f.ctx, "device.restore", payload)
		must(t, err)
		_, err = certificateRPC(t, f, server, joined, "", "")
		must(t, err)
		_, err = server.Handle(f.ctx, "device.restore", payload)
		must(t, err)
		// A headless maintenance sweep must retain the user's presence account.
		waitForRequestBudget()
		if count := host.RestoreOwnCredentials(f.ctx); count != 1 {
			t.Fatal("same identity headless maintenance failed", count)
		}
		f.server.stop(t, false)
		f.startServer(t)
		reconcile, err := json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{}})
		must(t, err)
		_, err = server.Handle(f.ctx, "peer.autoconnect_reconcile", reconcile)
		must(t, err)
		deadline := time.Now().Add(5 * time.Second)
		for {
			members, err := f.client.NetworkDevices(f.ctx, session.Token, network.NetworkID)
			must(t, err)
			if len(members) == 1 && members[0].DeviceID == owner.DeviceID && members[0].Presence == "online" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("linked account lost online presence after repeat restore, maintenance and reconnect", members)
			}
			time.Sleep(50 * time.Millisecond)
		}
		assertCertificateBindings(t, f, owner)
		data, err = store.Get(key)
		must(t, err)
		must(t, json.Unmarshal(data, &canonical))
		if canonical["userId"] != owner.UserID {
			t.Fatal("presence synchronization changed canonical original owner")
		}
		// Exercise the explicitly supported historical state where both local
		// records contain a linked-account projection, then the certificate expires.
		host.Close()
		expired := setCoordinatorCertificateTime(t, f, -10*time.Second)
		canonical["userId"], canonical["certificate"] = session.User.UserID, expired.Certificate
		legacy, err := json.Marshal(canonical)
		must(t, err)
		index, err := json.Marshal(map[string]any{"version": 1, "services": []string{f.authority.ServiceID}})
		must(t, err)
		legacyStore := &certificateSecrets{values: map[string][]byte{key: legacy, "account.credential-index": index}}
		_, legacyServer, _ := certificateCore(t, f, legacyStore)
		expired.UserID = session.User.UserID
		recovered, err := certificateRPC(t, f, legacyServer, expired, network.NetworkID, session.Token)
		must(t, err)
		if bytes.Equal(recovered.Certificate, expired.Certificate) {
			t.Fatal("legacy projected owner prevented expired recovery")
		}
		data, err = legacyStore.Get(key)
		must(t, err)
		must(t, json.Unmarshal(data, &canonical))
		if canonical["userId"] != owner.UserID {
			t.Fatal("matching legacy owner projections overruled authenticated server owner")
		}
		assertCertificateBindings(t, f, recovered)
	})
	t.Run("renew-and-headless-restart", func(t *testing.T) {
		f := newFixture(t)
		time.Sleep(time.Second)
		due := setCoordinatorCertificateTime(t, f, 2*24*time.Hour)
		store := &certificateSecrets{values: map[string][]byte{}}
		host, server, callbacks := certificateCore(t, f, store)
		renewed, err := certificateRPC(t, f, server, due, f.config[0].Pin.Pair.NetworkID, "")
		must(t, err)
		if bytes.Equal(renewed.Certificate, due.Certificate) {
			t.Fatal("real server did not renew due certificate")
		}
		assertCertificateBindings(t, f, renewed)
		stale, err := certificateRPC(t, f, server, due, "", "")
		must(t, err)
		if !bytes.Equal(stale.Certificate, renewed.Certificate) {
			t.Fatal("stale shell downgraded renewed canonical certificate")
		}
		restore := func(device controlplane.Device) error {
			payload, err := json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": map[string]any{"device": device, "accountUserId": f.userSession.User.UserID, "privateKey": f.config[0].Private, "pins": []controlplane.PairIdentity{}}})
			must(t, err)
			_, err = server.Handle(f.ctx, "device.restore", payload)
			return err
		}
		must(t, restore(due))
		must(t, restore(due))
		conflict := due
		conflict.DeviceID = protocol.NewID()
		if err := restore(conflict); err == nil || err.Error() != "p2p.identity_mismatch" {
			t.Fatal("different identity restore was not refused", err)
		}
		host.Close()
		f.server.stop(t, false)
		f.startServer(t)
		restarted, _, _ := certificateCore(t, f, store)
		if restored := restarted.RestoreOwnCredentials(f.ctx); restored != 1 {
			t.Fatal("headless canonical restore did not resume one original device", restored)
		}
		readback, err := f.client.ReadCertificate(f.ctx, due.DeviceID, f.config[0].Private, f.authority)
		must(t, err)
		if !bytes.Equal(readback.Certificate, renewed.Certificate) {
			t.Fatal("restart issued another certificate")
		}
		callbacks.mu.Lock()
		runtimeCalls := callbacks.runtimeCalls
		callbacks.mu.Unlock()
		if runtimeCalls != 0 {
			t.Fatal("certificate maintenance requested DSH")
		}
	})
	t.Run("authorized-expired-recovery", func(t *testing.T) {
		f := newFixture(t)
		time.Sleep(time.Second)
		expired := setCoordinatorCertificateTime(t, f, -10*time.Second)
		_, server, _ := certificateCore(t, f, &certificateSecrets{values: map[string][]byte{}})
		_, err := certificateRPC(t, f, server, expired, f.config[0].Pin.Pair.NetworkID, "")
		if err == nil || err.Error() != "p2p.certificate_recovery_required" {
			t.Fatal("expired credential did not request authorization", err)
		}
		recovered, err := certificateRPC(t, f, server, expired, f.config[0].Pin.Pair.NetworkID, f.userSession.Token)
		must(t, err)
		if bytes.Equal(recovered.Certificate, expired.Certificate) {
			t.Fatal("real expired recovery did not replace certificate")
		}
		assertCertificateBindings(t, f, recovered)
	})
	t.Run("discarded-recovery-response-and-restart", func(t *testing.T) {
		f := newFixture(t)
		time.Sleep(time.Second)
		expired := setCoordinatorCertificateTime(t, f, -10*time.Second)
		store := &certificateSecrets{values: map[string][]byte{}}
		host, server, _ := certificateCore(t, f, store)
		_, err := certificateRPC(t, f, server, expired, f.config[0].Pin.Pair.NetworkID, "")
		if err == nil || err.Error() != "p2p.certificate_recovery_required" {
			t.Fatal(err)
		}
		grant, err := f.client.EnrollmentToken(f.ctx, f.userSession.Token, f.config[0].Pin.Pair.NetworkID)
		must(t, err)
		// The oracle discards the committed response; the restarted core receives
		// only its old expired canonical record and no recovery grant/session.
		_, err = f.client.RecoverCertificate(f.ctx, expired, f.config[0].Private, f.authority, protocol.NewID(), grant.Token)
		must(t, err)
		host.Close()
		f.server.stop(t, false)
		f.startServer(t)
		_, restarted, _ := certificateCore(t, f, store)
		actual, err := certificateRPC(t, f, restarted, expired, "", "")
		must(t, err)
		if bytes.Equal(actual.Certificate, expired.Certificate) {
			t.Fatal("committed recovery was not read back")
		}
		assertCertificateBindings(t, f, actual)
		_, err = f.client.RecoverCertificate(f.ctx, expired, f.config[0].Private, f.authority, protocol.NewID(), grant.Token)
		if err == nil || err.Error() != "p2p.certificate_not_expired" {
			t.Fatal("readback changed server recovery state", err)
		}
	})
}
