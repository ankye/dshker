//go:build windows || (native_secrets && (darwin || linux))

package integration

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// This gate uses an explicitly supplied independent production coordinator,
// production Helper/Core dispatch and the actual OS protected store. Only a
// random regression namespace is opened; installed account keys are untouched.
func TestAccountSessionRecoveryRealCoordinatorAndNativeStore(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 90*time.Second)
	defer cancel()
	dataRoot := t.TempDir()
	namespace := "regression-account-recovery-" + protocol.NewNonce()
	store, err := secret.OpenNamespace(dataRoot, namespace)
	must(t, err)
	key := "peer-user-session:" + f.authority.ServiceID
	t.Cleanup(func() {
		if err := store.Delete(key); err != nil {
			t.Error("isolated account secret cleanup failed", err)
		}
	})
	firstHost, first := accountRecoveryNativeCore(t, ctx, f, store)
	beforeLogin := time.Now()
	login := accountRecoveryCall(t, ctx, first, f, "user.login", map[string]string{"username": f.userSession.User.Username, "password": f.password})
	var original controlplane.UserSession
	accountRecoveryDecode(t, login, &original)
	if original.User != f.userSession.User || original.ExpiresAt < beforeLogin.Add(30*24*time.Hour).Unix() {
		t.Fatal("production helper login did not retain the account and server's thirty-day expiry")
	}
	beforeNetworks, err := f.client.Networks(ctx, original.Token)
	must(t, err)
	beforeDevices, err := f.client.UserDevices(ctx, original.Token)
	must(t, err)
	beforePairs, err := f.client.NetworkPairs(ctx, original.Token, f.config[0].Pin.Pair.NetworkID)
	must(t, err)
	beforeRenew := time.Now()
	var renewed controlplane.UserSession
	accountRecoveryDecode(t, accountRecoveryCall(t, ctx, first, f, "user.renew", map[string]string{"token": original.Token}), &renewed)
	if renewed.Token != original.Token || renewed.User != original.User || renewed.ExpiresAt < beforeRenew.Add(30*24*time.Hour).Unix() {
		t.Fatal("production renewal changed identity or invented expiry")
	}
	expected := integrationSessionRecord(t, renewed)
	actual, err := store.Get(key)
	must(t, err)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("renewal replied before native canonical readback matched")
	}
	// Represent the stale local deadline left by a lost earlier renewal reply.
	// The real server session is unchanged and remains the sole authority.
	stale := renewed
	stale.ExpiresAt = time.Now().Add(-time.Second).Unix()
	must(t, store.Set(key, integrationSessionRecord(t, stale)))
	firstHost.Close()
	reopened, err := secret.OpenNamespace(dataRoot, namespace)
	must(t, err)
	_, restarted := accountRecoveryNativeCore(t, ctx, f, reopened)
	var restored controlplane.UserSession
	accountRecoveryDecode(t, accountRecoveryCall(t, ctx, restarted, f, "user.renew", map[string]string{"token": original.Token}), &restored)
	if restored.User != original.User || restored.Token != original.Token || restored.ExpiresAt < renewed.ExpiresAt {
		t.Fatal("restart could not reconcile a live server session with stale local expiry")
	}
	command := exec.CommandContext(ctx, f.binary, "user-reset-code", "--config", f.configPath, "--username", original.User.Username)
	output, err := command.Output()
	must(t, err)
	var grant struct {
		User      controlplane.User `json:"user"`
		Code      string            `json:"code"`
		ExpiresAt int64             `json:"expiresAt"`
	}
	must(t, protocol.DecodeExact(output, &grant))
	if grant.User != original.User || len(grant.Code) != 64 || grant.ExpiresAt <= time.Now().Unix() {
		t.Fatal("admin CLI did not issue an account-scoped recovery code")
	}
	password := strings.Repeat("新", 12)
	var reset struct {
		Reset bool `json:"reset"`
	}
	accountRecoveryDecode(t, accountRecoveryCall(t, ctx, restarted, f, "user.resetPassword", map[string]string{"email": original.User.Username, "code": grant.Code, "password": password}), &reset)
	clear(output)
	if !reset.Reset {
		t.Fatal("helper did not confirm explicit recovery")
	}
	if _, err := reopened.Get(key); !errors.Is(err, secret.ErrMissing) {
		t.Fatal("matching canonical native login survived reset", err)
	}
	if _, err := f.client.CurrentUser(ctx, original.Token); err == nil || err.Error() != "p2p.user_unauthorized" {
		t.Fatal("reset did not revoke the old server session", err)
	}
	if _, err := f.client.RenewUserSession(ctx, original.Token); err == nil || err.Error() != "p2p.user_unauthorized" {
		t.Fatal("reset session regained authority through renewal", err)
	}
	if _, err := f.client.Login(ctx, original.User.Username, f.password); err == nil || err.Error() != "p2p.login_failed" {
		t.Fatal("old password remained usable", err)
	}
	var recovered controlplane.UserSession
	accountRecoveryDecode(t, accountRecoveryCall(t, ctx, restarted, f, "user.login", map[string]string{"username": original.User.Username, "password": password}), &recovered)
	if recovered.User != original.User || recovered.Token == original.Token {
		t.Fatal("new password replaced the account or reused revoked authentication")
	}
	afterNetworks, err := f.client.Networks(ctx, recovered.Token)
	must(t, err)
	afterDevices, err := f.client.UserDevices(ctx, recovered.Token)
	must(t, err)
	afterPairs, err := f.client.NetworkPairs(ctx, recovered.Token, f.config[0].Pin.Pair.NetworkID)
	must(t, err)
	if !reflect.DeepEqual(beforeNetworks, afterNetworks) || !reflect.DeepEqual(beforeDevices, afterDevices) || !reflect.DeepEqual(beforePairs, afterPairs) {
		t.Fatal("password recovery changed the original network, devices or pair records")
	}
	for index, config := range f.config {
		device, err := f.devices[index].ReadCertificate(ctx, config.Device.DeviceID, config.Private, f.authority)
		must(t, err)
		if !reflect.DeepEqual(device, config.Device) {
			t.Fatal("password recovery replaced an original device key or certificate")
		}
	}
	if err := f.client.ResetPassword(ctx, original.User.Username, grant.Code, password); err == nil || err.Error() != "p2p.password_reset_invalid" {
		t.Fatal("consumed recovery code remained usable", err)
	}
}

func accountRecoveryNativeCore(t *testing.T, ctx context.Context, f *realCoordinator, store secret.Store) (*helper.Host, core.Serve) {
	t.Helper()
	host := helper.New(ctx)
	t.Cleanup(host.Close)
	root, err := x509.ParseCertificate(f.root)
	must(t, err)
	roots := x509.NewCertPool()
	roots.AddCert(root)
	host.SetRoots(roots)
	host.SetDeviceKeys(store)
	server := core.Serve{Store: store, Peer: host}
	payload, err := json.Marshal(map[string]any{"endpoints": f.endpoints, "pinnedKey": f.authority.PublicKey, "telemetry": controlplane.Telemetry{}})
	must(t, err)
	_, err = server.Handle(ctx, "service.configure", payload)
	must(t, err)
	return host, server
}

func accountRecoveryCall(t *testing.T, ctx context.Context, server core.Serve, f *realCoordinator, method string, data any) any {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"serviceId": f.authority.ServiceID, "data": data})
	must(t, err)
	value, err := server.Handle(ctx, method, payload)
	if err != nil {
		t.Fatal("production account recovery operation failed: "+method, err)
	}
	return value
}

func accountRecoveryDecode(t *testing.T, value, target any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	must(t, err)
	must(t, protocol.DecodeExact(encoded, target))
}
