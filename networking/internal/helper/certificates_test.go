package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func certificateError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || err.Error() != want {
		t.Fatalf("got %v, want %s", err, want)
	}
}

func TestCertificateOutsideWindowPersistsExactLegacySchema(t *testing.T) {
	f := newCertificateFixture(t, 20*24*time.Hour)
	result, err := f.call(f.original, f.networkID, "")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result.Certificate, f.original.Certificate) || f.renewals != 0 || f.recoveries != 0 {
		t.Fatal("outside-window credential changed or issued")
	}
	data, err := f.store.Get(credentialKey(f.account.identity.ServiceID))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields) != 10 || fields["networkId"] != nil || fields["pendingRequestId"] != nil {
		t.Fatal("version-1 credential schema changed", string(data))
	}
	metadata, err := f.host.loadCertificateMetadata(f.account.identity.ServiceID)
	if err != nil || metadata.Version != 1 || metadata.NetworkID != f.networkID || metadata.PendingRequestID != "" {
		t.Fatal("explicit recovery scope was not recorded", metadata, err)
	}
	public, _ := json.Marshal(result)
	var response map[string]json.RawMessage
	_ = json.Unmarshal(public, &response)
	if len(response) != 3 || response["privateKey"] != nil || response["certificate"] == nil {
		t.Fatal("certificate RPC exposed extra fields", string(public))
	}
}

func TestCertificateRenewalIsSerializedAndCanonicalDefeatsStaleShell(t *testing.T) {
	f := newCertificateFixture(t, 3*24*time.Hour)
	var group sync.WaitGroup
	errors := make(chan error, 16)
	for range 16 {
		group.Add(1)
		go func() { defer group.Done(); _, err := f.call(f.original, f.networkID, ""); errors <- err }()
	}
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if f.renewals != 1 || f.recoveries != 0 {
		t.Fatalf("concurrent calls issued %d renewals, %d recoveries", f.renewals, f.recoveries)
	}
	canonical, err := f.host.LoadCredential(f.account.identity.ServiceID)
	if err != nil || !bytes.Equal(canonical.Certificate, f.current.Certificate) || bytes.Equal(canonical.Certificate, f.original.Certificate) {
		t.Fatal("canonical did not retain renewal", err)
	}
	again, err := f.call(f.original, "", "")
	if err != nil || !bytes.Equal(again.Certificate, canonical.Certificate) || f.renewals != 1 {
		t.Fatal("stale shell downgraded canonical certificate", err)
	}
	conflict := f.original
	conflict.PublicKey = make([]byte, 32)
	_, err = f.call(conflict, "", "")
	certificateError(t, err, "p2p.identity_mismatch")
}

func TestCertificateServerOwnerRepairsLegacyAccountProjections(t *testing.T) {
	for _, remaining := range []time.Duration{20 * 24 * time.Hour, -time.Hour} {
		for _, projection := range []struct {
			name             string
			canonical, shell bool
		}{{"canonical-only", true, false}, {"shell-only", false, true}, {"both-copies", true, true}} {
			t.Run(projection.name+"-"+remaining.String(), func(t *testing.T) {
				f := newCertificateFixture(t, remaining)
				linked := protocol.NewID()
				canonical, shell := f.original, f.original
				if projection.canonical {
					canonical.UserID = linked
				}
				if projection.shell {
					shell.UserID = linked
				}
				if err := f.host.SaveCredential(f.account.identity.ServiceID, canonical, f.private); err != nil {
					t.Fatal(err)
				}
				result, err := f.call(shell, f.networkID, strings.Repeat("s", 64))
				if err != nil {
					t.Fatal(err)
				}
				stored, err := f.host.LoadCredential(f.account.identity.ServiceID)
				if err != nil || stored.UserID != f.original.UserID || result.DeviceID != f.original.DeviceID || !bytes.Equal(stored.PublicKey, f.original.PublicKey) {
					t.Fatal("local projections overruled authenticated device owner", err)
				}
				if remaining > controlplane.CertificateRenewalWindow && (f.renewals != 0 || f.recoveries != 0 || !bytes.Equal(stored.Certificate, f.original.Certificate)) {
					t.Fatal("owner readback issued a certificate outside the renewal window")
				}
			})
		}
	}
}

func TestExpiredCertificateRequiresExplicitScopeAndSession(t *testing.T) {
	for _, test := range []struct{ name, network, token string }{{"neither", "", ""}, {"network-only", "network", ""}, {"session-only", "", strings.Repeat("s", 64)}} {
		t.Run(test.name, func(t *testing.T) {
			f := newCertificateFixture(t, -time.Hour)
			network := test.network
			if network != "" {
				network = f.networkID
			}
			_, err := f.call(f.original, network, test.token)
			certificateError(t, err, "p2p.certificate_recovery_required")
			if f.grants != 0 || f.recoveries != 0 || f.renewals != 0 {
				t.Fatal("missing authorization performed issuance")
			}
			canonical, err := f.host.LoadCredential(f.account.identity.ServiceID)
			if err != nil || !bytes.Equal(canonical.Certificate, f.original.Certificate) {
				t.Fatal("missing authorization replaced credential", err)
			}
		})
	}
}

func TestExpiredCertificateRecoversOriginalIdentityWithAuthorizedGrant(t *testing.T) {
	f := newCertificateFixture(t, -time.Hour)
	result, err := f.call(f.original, f.networkID, strings.Repeat("s", 64))
	if err != nil {
		t.Fatal(err)
	}
	if result.DeviceID != f.original.DeviceID || !bytes.Equal(result.PublicKey, f.original.PublicKey) || bytes.Equal(result.Certificate, f.original.Certificate) || f.recoveries != 1 || f.grants != 1 || f.renewals != 0 {
		t.Fatal("recovery changed identity or did not use exact grant")
	}
	if _, err := f.account.base.ValidateDevice(controlplane.Device{DeviceID: result.DeviceID, UserID: f.original.UserID, Name: f.original.Name, PublicKey: result.PublicKey, Certificate: result.Certificate}, f.private, f.account.identity, false); err != nil {
		t.Fatal(err)
	}
	metadata, err := f.host.loadCertificateMetadata(f.account.identity.ServiceID)
	if err != nil || metadata.PendingRequestID != "" || metadata.NetworkID != f.networkID {
		t.Fatal("completed recovery did not clear pending ID", metadata, err)
	}
}

func TestRecoveryRefusalPreservesLoginAndEnrollment(t *testing.T) {
	f := newCertificateFixture(t, -time.Hour)
	f.grantCode = "p2p.network_not_found"
	f.account.rememberToken(strings.Repeat("s", 64))
	_, err := f.call(f.original, f.networkID, strings.Repeat("s", 64))
	certificateError(t, err, "p2p.certificate_recovery_forbidden")
	f.account.directory.mu.Lock()
	token := f.account.directory.token
	f.account.directory.mu.Unlock()
	if token != strings.Repeat("s", 64) || f.recoveries != 0 {
		t.Fatal("forbidden recovery cleared login or issued certificate")
	}
	_, err = f.call(f.original, protocol.NewID(), strings.Repeat("s", 64))
	certificateError(t, err, "p2p.certificate_recovery_forbidden")
	if f.grants != 1 {
		t.Fatal("conflicting explicit network requested a grant")
	}
}

func TestCertificateLostRecoveryReplySurvivesRestartWithoutAnotherGrant(t *testing.T) {
	f := newCertificateFixture(t, -time.Hour)
	f.lostReply = true
	_, err := f.call(f.original, f.networkID, strings.Repeat("s", 64))
	certificateError(t, err, "p2p.certificate_sync_failed")
	metadata, err := f.host.loadCertificateMetadata(f.account.identity.ServiceID)
	if err != nil || !protocol.ValidID(metadata.PendingRequestID) {
		t.Fatal("ambiguous issuance lost durable request ID", err)
	}
	// A fresh host starts from the exact same protected records and original key.
	old := f.host
	f.host = New(context.Background())
	f.host.SetDeviceKeys(f.store)
	f.host.BindMain(certificateMain{f})
	f.account.host = f.host
	f.host.accounts[f.account.identity.ServiceID] = f.account
	old.mu.Lock()
	delete(old.accounts, f.account.identity.ServiceID)
	old.mu.Unlock()
	old.Close()
	t.Cleanup(f.host.Close)
	result, err := f.call(f.original, "", "")
	if err != nil || !bytes.Equal(result.Certificate, f.current.Certificate) || f.grants != 1 || f.recoveries != 1 {
		t.Fatal("restart repeated recovery instead of authenticated readback", err)
	}
}

func (f *certificateFixture) restore(device controlplane.Device) error {
	data, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": device, "privateKey": f.private, "pins": []controlplane.PairIdentity{}, "accountUserId": ""}})
	_, err := f.host.Handle(context.Background(), "device.restore", data)
	return err
}

func TestOnlineCertificateMaintenancePreservesManagerAndSubscription(t *testing.T) {
	f := newCertificateFixture(t, 30*24*time.Hour)
	if err := f.restore(f.original); err != nil {
		t.Fatal(err)
	}
	manager := f.account.manager
	client := f.account.client
	// Represent the same running identity after it enters the renewal window.
	due := f.original
	due.Certificate = f.sign(time.Now().Add(time.Hour))
	f.mu.Lock()
	f.current = due
	f.mu.Unlock()
	if err := f.host.SaveCredential(f.account.identity.ServiceID, due, f.private); err != nil {
		t.Fatal(err)
	}
	if err := f.account.maintainCertificate(f.host.ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.restore(due); err != nil {
		t.Fatal("same-device restore was not idempotent", err)
	}
	if f.account.manager != manager || f.account.client != client || f.subscriptions != 1 || f.runtimeCalls != 0 || f.renewals != 1 {
		t.Fatal("renewal replaced peer ownership or started DSH")
	}
	conflicting := due
	conflicting.DeviceID = protocol.NewID()
	certificateError(t, f.restore(conflicting), "p2p.identity_mismatch")
}

func TestOnlineExpiredClientUsesUnauthenticatedTLSForReadbackAndRecovery(t *testing.T) {
	f := newCertificateFixture(t, 2*time.Second)
	// A running client's TLS callback is allowed to expire after failed renewal.
	client, err := f.account.base.WithDevice(f.original, f.private, f.account.identity)
	if err != nil {
		t.Fatal(err)
	}
	f.account.client = client
	f.account.httpPhase = accountHTTPDevice
	f.account.device = f.original
	leaf, err := f.account.base.ValidateDevice(f.original, f.private, f.account.identity, false)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(leaf.NotAfter) + 50*time.Millisecond)
	expired := f.original
	if err := f.host.SaveCredential(f.account.identity.ServiceID, expired, f.private); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.current = expired
	f.mu.Unlock()
	result, err := f.call(expired, f.networkID, strings.Repeat("s", 64))
	if err != nil || f.account.client != client || !bytes.Equal(f.account.device.Certificate, result.Certificate) || f.recoveries != 1 {
		t.Fatal("online expiry could not recover over trusted certificate-free HTTPS", err)
	}
}
