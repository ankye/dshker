package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type certificateFaultStore struct {
	*memoryStore
	mu        sync.Mutex
	key, mode string
	enabled   bool
}

func (store *certificateFaultStore) Get(key string) ([]byte, error) {
	store.mu.Lock()
	enabled, mode, target := store.enabled, store.mode, store.key
	store.mu.Unlock()
	if enabled && key == target && mode == "read" {
		return nil, errors.New("test protected read failure")
	}
	return store.memoryStore.Get(key)
}

func (store *certificateFaultStore) Set(key string, value []byte) error {
	store.mu.Lock()
	enabled, mode, target := store.enabled, store.mode, store.key
	store.mu.Unlock()
	if enabled && key == target {
		if mode == "write" {
			return errors.New("test protected write failure")
		}
		if mode == "drop" {
			return nil
		}
	}
	return store.memoryStore.Set(key, value)
}

func TestCertificatePersistenceFailuresRetainServerProgressForRetry(t *testing.T) {
	for _, test := range []struct{ record, mode string }{{"credential", "write"}, {"credential", "drop"}, {"credential", "read"}, {"metadata", "write"}, {"metadata", "drop"}, {"metadata", "read"}} {
		t.Run(test.record+"-"+test.mode, func(t *testing.T) {
			f := newCertificateFixture(t, -time.Hour)
			key := credentialKey(f.account.identity.ServiceID)
			if test.record == "metadata" {
				key = certificateMetadataKey(f.account.identity.ServiceID)
			}
			fault := &certificateFaultStore{memoryStore: f.store, key: key, mode: test.mode}
			f.host.SetDeviceKeys(fault)
			f.afterIssue = func() { fault.mu.Lock(); fault.enabled = true; fault.mu.Unlock() }
			_, err := f.call(f.original, f.networkID, strings.Repeat("s", 64))
			certificateError(t, err, "p2p.certificate_persist_failed")
			fault.mu.Lock()
			fault.enabled = false
			fault.mu.Unlock()
			f.afterIssue = nil
			result, err := f.call(f.original, "", "")
			if err != nil || f.grants != 1 || f.recoveries != 1 || !bytes.Equal(result.Certificate, f.current.Certificate) {
				t.Fatal("persistence retry repeated issuance or lost server certificate", err)
			}
			metadata, err := f.host.loadCertificateMetadata(f.account.identity.ServiceID)
			if err != nil || metadata.PendingRequestID != "" {
				t.Fatal("successful retry retained stale pending operation", err)
			}
		})
	}
}

func TestCertificateUnreadableRecordsNeverAuthorizeEnrollmentOrIssuance(t *testing.T) {
	for _, test := range []string{"credential-corrupt", "metadata-corrupt", "index-corrupt", "provider-offline", "no-provider"} {
		t.Run(test, func(t *testing.T) {
			f := newCertificateFixture(t, -time.Hour)
			switch test {
			case "credential-corrupt":
				_ = f.store.Set(credentialKey(f.account.identity.ServiceID), []byte(`{"version":1}`))
			case "metadata-corrupt":
				_ = f.store.Set(certificateMetadataKey(f.account.identity.ServiceID), []byte(`{"version":1,"networkId":"invented"}`))
			case "index-corrupt":
				_ = f.store.Set(credentialIndexName, []byte(`{"version":1,"services":["invalid space"]}`))
			case "provider-offline":
				f.store.mu.Lock()
				f.store.failed = true
				f.store.mu.Unlock()
			case "no-provider":
				f.host.SetDeviceKeys(nil)
			}
			_, err := f.call(f.original, f.networkID, strings.Repeat("s", 64))
			if err == nil || (err.Error() != "p2p.certificate_sync_failed" && err.Error() != "p2p.certificate_persist_failed") {
				t.Fatal("unreadable canonical state was not typed", err)
			}
			if f.queries != 0 || f.renewals != 0 || f.recoveries != 0 || f.grants != 0 {
				t.Fatal("unreadable state reached network issuance")
			}
		})
	}
}

func TestCertificateRPCOptionalFieldsAreLocallyStrict(t *testing.T) {
	f := newCertificateFixture(t, 20*24*time.Hour)
	required := map[string]any{"device": f.original, "privateKey": f.private}
	for _, change := range []func(map[string]any){
		func(fields map[string]any) { fields["unknown"] = true },
		func(fields map[string]any) { fields["token"] = nil },
		func(fields map[string]any) { fields["networkId"] = 42 },
		func(fields map[string]any) { fields["networkId"] = "" },
		func(fields map[string]any) { delete(fields, "privateKey") },
	} {
		fields := map[string]any{}
		for key, value := range required {
			fields[key] = value
		}
		change(fields)
		data, _ := json.Marshal(fields)
		_, _, _, err := decodeCertificateRequest(data)
		certificateError(t, err, "p2p.invalid_request")
	}
	valid, _ := json.Marshal(required)
	_, _, _, err := decodeCertificateRequest(append(valid[:len(valid)-1], []byte(`,"token":"one","token":"two"}`)...))
	certificateError(t, err, "p2p.invalid_request")
}

func TestCertificateCancellationAndShutdownCannotInstallOrIssue(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{false: "caller-cancel", true: "host-close"}[shutdown], func(t *testing.T) {
			f := newCertificateFixture(t, 3*24*time.Hour)
			f.queryEntered = make(chan struct{}, 1)
			f.queryRelease = make(chan struct{})
			defer close(f.queryRelease)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private}})
			result := make(chan error, 1)
			go func() { _, err := f.host.Handle(ctx, "device.certificate", payload); result <- err }()
			select {
			case <-f.queryEntered:
			case <-time.After(3 * time.Second):
				t.Fatal("query did not start")
			}
			if shutdown {
				f.host.Close()
			} else {
				cancel()
			}
			select {
			case err := <-result:
				certificateError(t, err, "p2p.request_cancelled")
			case <-time.After(3 * time.Second):
				t.Fatal("cancelled maintenance kept work alive")
			}
			if f.renewals != 0 || f.recoveries != 0 || f.account.client != nil {
				t.Fatal("cancelled operation issued or activated")
			}
		})
	}
}

func TestCertificateForgedReadbackCannotReplaceCanonicalCredential(t *testing.T) {
	f := newCertificateFixture(t, 3*24*time.Hour)
	if err := f.host.SaveCredential(f.account.identity.ServiceID, f.original, f.private); err != nil {
		t.Fatal(err)
	}
	f.current.DeviceID = protocol.NewID()
	_, err := f.call(f.original, f.networkID, "")
	certificateError(t, err, "p2p.identity_mismatch")
	canonical, err := f.host.LoadCredential(f.account.identity.ServiceID)
	if err != nil || !bytes.Equal(canonical.Certificate, f.original.Certificate) || f.renewals != 0 {
		t.Fatal("foreign readback replaced original credential", err)
	}
}

func TestCertificateCancelledCommittedRecoveryResumesFromReadback(t *testing.T) {
	f := newCertificateFixture(t, -time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.afterIssue = cancel
	payload, err := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "networkId": f.networkID, "token": strings.Repeat("s", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.host.Handle(ctx, "device.certificate", payload)
	certificateError(t, err, "p2p.request_cancelled")
	canonical, err := f.host.LoadCredential(f.account.identity.ServiceID)
	if err != nil || !bytes.Equal(canonical.Certificate, f.original.Certificate) || f.account.client != nil {
		t.Fatal("cancelled issuance activated or replaced the local credential", err)
	}
	f.mu.Lock()
	f.afterIssue = nil
	f.mu.Unlock()
	result, err := f.call(f.original, "", "")
	if err != nil || !bytes.Equal(result.Certificate, f.current.Certificate) || f.grants != 1 || f.recoveries != 1 {
		t.Fatal("cancelled committed recovery repeated authorization or issuance", err)
	}
}

func TestSameIdentityRestoreRejectsConflictingPrivateKeyBeforeManagerChanges(t *testing.T) {
	f := newCertificateFixture(t, 20*24*time.Hour)
	if err := f.restore(f.original); err != nil {
		t.Fatal(err)
	}
	manager := f.account.manager
	other, _, err := controlplane.NewDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	f.private = other
	certificateError(t, f.restore(f.original), "p2p.identity_mismatch")
	if f.account.manager != manager || f.subscriptions != 1 {
		t.Fatal("foreign identity replaced manager")
	}
}
