package peerbroker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/ankye/dshker/networking/internal/remoteroute"
)

// started returns one running broker with a working runtime source.
func started(t *testing.T) (*Broker, remoteroute.Descriptor, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "remote-peer.json")
	broker := &Broker{
		DescriptorPath: path,
		Runtime: func(context.Context) (string, error) {
			return "http://127.0.0.1:3088/?token=abc", nil
		},
	}
	descriptor, err := broker.Start()
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = broker.Shutdown() })
	return broker, descriptor, path
}

// request sends one request with the given bearer header to the broker's own
// handler. The handler is always built from the published secret, so a test can
// present a wrong one.
func request(t *testing.T, broker *Broker, headerSecret, method, path, remoteAddress string) *httptest.ResponseRecorder {
	t.Helper()
	descriptor, live := broker.Descriptor()
	if !live {
		t.Fatal("no running broker")
	}
	request := httptest.NewRequest(method, path, nil)
	request.RemoteAddr = remoteAddress
	if headerSecret != "" {
		request.Header.Set("Authorization", "Bearer "+headerSecret)
	}
	recorder := httptest.NewRecorder()
	broker.handler(descriptor.Secret).ServeHTTP(recorder, request)
	return recorder
}

// TestStartPublishesOneDescriptor pins the document a remote peer fetches: the
// format, the version, one instance id, the bound port, and a 32-byte secret.
func TestStartPublishesOneDescriptor(t *testing.T) {
	broker, descriptor, path := started(t)
	if descriptor.Format != remoteroute.DescriptorFormat || descriptor.Version != remoteroute.ProtocolVersion {
		t.Fatalf("descriptor = %+v", descriptor)
	}
	if descriptor.Port <= 0 || descriptor.InstanceID == "" || descriptor.Secret == "" {
		t.Fatalf("descriptor = %+v", descriptor)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("descriptor file: %v", err)
	}
	parsed, err := remoteroute.ParseDescriptor(raw)
	if err != nil || parsed != descriptor {
		t.Fatalf("published = %+v, %v", parsed, err)
	}
	// Windows has no POSIX permission bits: the descriptor lives in the user's
	// own profile and inherits its ACLs, which is the platform's protection. The
	// explicit mode is what the POSIX platforms are held to, the way the private
	// endpoint record already is.
	if info, err := os.Stat(path); err == nil && runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	// The broker binds loopback only, so the descriptor is not a network address.
	if _, live := broker.Descriptor(); !live {
		t.Fatal("a running broker reported no descriptor")
	}
	if _, err := broker.Start(); !errors.Is(err, remoteroute.ErrConnectionBusy) {
		t.Fatalf("second start = %v", err)
	}
}

// TestBrokerAnswersOnlyItsOwnLoopbackPeer covers every refusal the endpoint owes.
func TestBrokerAnswersOnlyItsOwnLoopbackPeer(t *testing.T) {
	broker, descriptor, _ := started(t)
	remote := request(t, broker, descriptor.Secret, http.MethodPost, "/v1/runtime/connect", "10.0.0.5:50123")
	if remote.Code != http.StatusForbidden {
		t.Fatalf("a non-loopback peer = %d", remote.Code)
	}
	wrongPath := request(t, broker, descriptor.Secret, http.MethodPost, "/v1/runtime/other", "127.0.0.1:50123")
	if wrongPath.Code != http.StatusNotFound {
		t.Fatalf("another route = %d", wrongPath.Code)
	}
	wrongMethod := request(t, broker, descriptor.Secret, http.MethodGet, "/v1/runtime/connect", "127.0.0.1:50123")
	if wrongMethod.Code != http.StatusNotFound {
		t.Fatalf("another method = %d", wrongMethod.Code)
	}
	noBearer := request(t, broker, "", http.MethodPost, "/v1/runtime/connect", "127.0.0.1:50123")
	if noBearer.Code != http.StatusUnauthorized {
		t.Fatalf("no bearer = %d", noBearer.Code)
	}
	wrongBearer := request(t, broker, "not-the-secret", http.MethodPost, "/v1/runtime/connect", "127.0.0.1:50123")
	if wrongBearer.Code != http.StatusUnauthorized {
		t.Fatalf("another bearer = %d", wrongBearer.Code)
	}
	// A prefix of the real secret is not the secret.
	short := descriptor.Secret[:len(descriptor.Secret)-1]
	if prefix := request(t, broker, short, http.MethodPost, "/v1/runtime/connect", "127.0.0.1:50123"); prefix.Code != http.StatusUnauthorized {
		t.Fatalf("a truncated bearer = %d", prefix.Code)
	}
	malformed := request(t, broker, descriptor.Secret, http.MethodPost, "/v1/runtime/connect", "not-an-address")
	if malformed.Code != http.StatusForbidden {
		t.Fatalf("a malformed peer address = %d", malformed.Code)
	}
	accepted := request(t, broker, descriptor.Secret, http.MethodPost, "/v1/runtime/connect", "[::1]:50123")
	if accepted.Code != http.StatusOK {
		t.Fatalf("an ipv6 loopback peer = %d", accepted.Code)
	}
	var answer struct {
		Version int    `json:"version"`
		URL     string `json:"url"`
	}
	if json.Unmarshal(accepted.Body.Bytes(), &answer) != nil || answer.Version != remoteroute.ProtocolVersion ||
		answer.URL != "http://127.0.0.1:3088/?token=abc" {
		t.Fatalf("answer = %s", accepted.Body.String())
	}
	// The answer carries exactly the two declared fields, and the client parser
	// accepts it as it is.
	var fields map[string]json.RawMessage
	if json.Unmarshal(accepted.Body.Bytes(), &fields) != nil || len(fields) != 2 {
		t.Fatalf("answer fields = %s", accepted.Body.String())
	}
	if _, err := remoteroute.ClassifyRuntimeResponse(accepted.Body.String()); err != nil {
		t.Fatalf("the client refused the broker answer: %v", err)
	}
}

// TestBrokerRefusesWithoutARuntime keeps the endpoint from inventing a session.
func TestBrokerRefusesWithoutARuntime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-peer.json")
	broker := &Broker{DescriptorPath: path, Runtime: func(context.Context) (string, error) {
		return "", errors.New("no runtime")
	}}
	descriptor, err := broker.Start()
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = broker.Shutdown() }()
	refused := request(t, broker, descriptor.Secret, http.MethodPost, "/v1/runtime/connect", "127.0.0.1:50123")
	if refused.Code != http.StatusServiceUnavailable {
		t.Fatalf("no runtime = %d", refused.Code)
	}
}

// TestShutdownRetractsTheEndpoint covers the core's own exit path.
func TestShutdownRetractsTheEndpoint(t *testing.T) {
	broker, _, path := started(t)
	if err := broker.Shutdown(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the descriptor survived the shutdown: %v", err)
	}
	if _, live := broker.Descriptor(); live {
		t.Fatal("a stopped broker reported a descriptor")
	}
}

func TestWriteDescriptorRefusesARelativePath(t *testing.T) {
	if err := writeDescriptor("remote-peer.json", remoteroute.Descriptor{}); err == nil {
		t.Fatal("a relative descriptor path was accepted")
	}
}
