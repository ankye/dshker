package peersession

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

func turnCredentialManager(t *testing.T, handler http.Handler) *Manager {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := controlplane.New(controlplane.Endpoints{
		HTTPSOrigin: server.URL,
		WSSURL:      "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/signals",
		STUNAddress: "127.0.0.1:3478",
	}, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	manager, _ := pinFixture()
	manager.client = client
	return manager
}

func writeTurnCredentials(t *testing.T, w http.ResponseWriter, deviceID string, expiry time.Time) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(controlplane.TurnCredentials{
		URLs:       []string{"turn:127.0.0.1:3478"},
		Username:   fmt.Sprintf("%d:%s", expiry.Unix(), deviceID),
		Credential: "relay-credential",
	}); err != nil {
		t.Errorf("encode credentials: %v", err)
	}
}

func TestTurnCredentialsCacheOnlyFreshDeviceCredentials(t *testing.T) {
	var requests atomic.Int32
	var manager *Manager
	manager = turnCredentialManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/turn-credentials" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		requests.Add(1)
		writeTurnCredentials(t, w, manager.config.Device.DeviceID, time.Now().Add(time.Hour))
	}))
	first, err := manager.turnEndpoints(context.Background())
	if err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	second, err := manager.turnEndpoints(context.Background())
	if err != nil {
		t.Fatalf("cached fetch: %v", err)
	}
	if requests.Load() != 1 || first.Username != second.Username {
		t.Fatalf("fresh credentials were not reused: requests=%d first=%q second=%q", requests.Load(), first.Username, second.Username)
	}
}

func TestTurnCredentialsRefreshExpiredCache(t *testing.T) {
	var requests atomic.Int32
	var manager *Manager
	manager = turnCredentialManager(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		writeTurnCredentials(t, w, manager.config.Device.DeviceID, time.Now().Add(time.Hour))
	}))
	manager.turnCreds = controlplane.TurnCredentials{
		URLs:       []string{"turn:127.0.0.1:3478"},
		Username:   fmt.Sprintf("%d:%s", time.Now().Add(-time.Minute).Unix(), manager.config.Device.DeviceID),
		Credential: "expired-credential",
	}
	manager.turnExpiresAt = time.Now().Add(-time.Minute)
	creds, err := manager.turnEndpoints(context.Background())
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if requests.Load() != 1 || creds.Credential == "expired-credential" {
		t.Fatalf("expired credentials were reused: requests=%d creds=%+v", requests.Load(), creds)
	}
}

func TestTurnCredentialFetchFailureIsRetried(t *testing.T) {
	var requests atomic.Int32
	var manager *Manager
	manager = turnCredentialManager(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"code": "p2p.server_unavailable"})
			return
		}
		writeTurnCredentials(t, w, manager.config.Device.DeviceID, time.Now().Add(time.Hour))
	}))
	if _, err := manager.turnEndpoints(context.Background()); err == nil || err.Error() != "p2p.server_unavailable" {
		t.Fatalf("first fetch error: %v", err)
	}
	if _, err := manager.turnEndpoints(context.Background()); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if requests.Load() != 2 {
		t.Fatalf("failed response was cached: %d requests", requests.Load())
	}
}

func TestTurnCredentialRefreshIsSingleFlight(t *testing.T) {
	var requests atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	var manager *Manager
	manager = turnCredentialManager(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			close(entered)
		}
		<-release
		writeTurnCredentials(t, w, manager.config.Device.DeviceID, time.Now().Add(time.Hour))
	}))
	const callers = 8
	var wait sync.WaitGroup
	wait.Add(callers)
	errors := make(chan error, callers)
	for range callers {
		go func() {
			defer wait.Done()
			_, err := manager.turnEndpoints(context.Background())
			errors <- err
		}()
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("credential request did not start")
	}
	close(release)
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("shared refresh failed: %v", err)
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("concurrent refresh issued %d requests", requests.Load())
	}
}

func TestTurnCredentialExpiryRejectsMalformedForeignAndStaleValues(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	deviceID := strings.Repeat("a", 12)
	for name, username := range map[string]string{
		"missing-expiry": deviceID,
		"invalid-expiry": "never:" + deviceID,
		"foreign-device": fmt.Sprintf("%d:%s", now.Add(time.Hour).Unix(), strings.Repeat("b", 12)),
		"refresh-window": fmt.Sprintf("%d:%s", now.Add(turnCredentialRefreshLead).Unix(), deviceID),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := turnCredentialExpiry(username, deviceID, now); err == nil || err.Error() != "p2p.invalid_server_response" {
				t.Fatalf("invalid username accepted: %q %v", username, err)
			}
		})
	}
	expected := now.Add(time.Hour).Truncate(time.Second)
	actual, err := turnCredentialExpiry(fmt.Sprintf("%d:%s", expected.Unix(), deviceID), deviceID, now)
	if err != nil || !actual.Equal(expected) {
		t.Fatalf("valid expiry rejected: %v %v", actual, err)
	}
}
