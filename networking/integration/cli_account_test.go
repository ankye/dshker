package integration

// Task 6.8: the account operations on the headless CLI path.
//
// `user.login`, `user.register` and `network.join` were reachable from a terminal
// but never exercised from one. That gap mattered because the CLI path is not the
// shell path: the command has to wrap each operation in the host's {serviceId,
// data} envelope, and a mistake there does not fail loudly — it produces a refusal
// that looks like an ordinary configuration problem. These tests drive a real
// `dshkerd serve` process with a stand-in coordinator so the envelope, the
// dispatch and the distinct refusal codes are all covered end to end.
//
// The coordinator here is a stub rather than the production server, which lives
// outside this repository and is what `DSHKER_SERVER_BINARY` points at. That is
// deliberate and it is the honest limit of this test: it proves the CLI path and
// the core's dispatch of these three methods, not the coordinator's own behavior.

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// accountCoordinator is a stand-in coordinator for the three account operations.
//
// It answers the real routes with the real shapes, because the core validates both:
// a login without a 64-character token or with an expired timestamp is rejected as
// `p2p.invalid_server_response`, so a lazy stub would pass for the wrong reason.
// The protocol admits only twelve lowercase hex characters for any id, so these are
// spelled that way rather than as readable words: a friendly-looking id is refused
// as p2p.invalid_server_response, which reads like a stub bug instead of a rule.
const (
	testUserID    = "aa00000000a1"
	testDeviceID  = "bb00000000b1"
	testNetworkID = "cc00000000c1"
)

type accountCoordinator struct {
	server *httptest.Server
	// seen records each path the CLI actually reached, which is how these tests
	// prove the command dispatched rather than refusing locally.
	seen map[string]int
}

func newAccountCoordinator(t *testing.T) *accountCoordinator {
	t.Helper()
	coordinator := &accountCoordinator{seen: make(map[string]int)}
	// A service identity the core will actually accept. The core verifies the nonce
	// it sent, the service id derived from the key, the endpoints, the Ed25519
	// signature over the canonical tuple, and that the certificate is a self-signed
	// CA holding the same key. A stub that skipped any of this would be refused with
	// p2p.identity_mismatch, so the identity is minted properly rather than faked.
	publicKey, privateKey, keyErr := ed25519.GenerateKey(rand.Reader)
	if keyErr != nil {
		t.Fatal(keyErr)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "dshker-test-service"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	authority, certErr := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if certErr != nil {
		t.Fatal(certErr)
	}
	handler := http.NewServeMux()
	handler.HandleFunc("/v1/identity", func(writer http.ResponseWriter, request *http.Request) {
		coordinator.seen["identity"]++
		var body struct {
			Nonce string `json:"nonce"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		serviceID := protocol.KeyID(publicKey)
		origin, signals, stun := coordinator.endpointsForAnswer()
		// The signature covers the exact tuple the client reconstructs; any drift
		// here is reported as an identity mismatch rather than a stub bug.
		tuple, marshalErr := json.Marshal([]any{
			"dshker.service.v1", protocol.Version, serviceID, []byte(publicKey),
			authority, body.Nonce, origin, signals, stun,
		})
		if marshalErr != nil {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		writeAccountJSON(writer, map[string]any{
			"version":     protocol.Version,
			"serviceId":   serviceID,
			"publicKey":   []byte(publicKey),
			"certificate": authority,
			"nonce":       body.Nonce,
			"httpsOrigin": origin,
			"wssUrl":      signals,
			"stunAddress": stun,
			"signature": base64.RawURLEncoding.EncodeToString(
				ed25519.Sign(privateKey, tuple)),
		})
	})
	handler.HandleFunc("/v1/register", func(writer http.ResponseWriter, request *http.Request) {
		coordinator.seen["register"]++
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || body.Email == "" {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		// Registration answers with the user only; a session needs a separate login.
		writeAccountJSON(writer, map[string]any{
			"userId":   testUserID,
			"username": body.Email,
		})
	})
	handler.HandleFunc("/v1/login", func(writer http.ResponseWriter, request *http.Request) {
		coordinator.seen["login"]++
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || body.Username == "" {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.Password == "wrong-password" {
			// A real rejection, so the CLI's refusal for bad credentials is covered
			// rather than only its success path.
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeAccountJSON(writer, map[string]any{
			"user":      map[string]any{"userId": testUserID, "username": body.Username},
			"token":     strings.Repeat("a", 64),
			"expiresAt": time.Now().Add(time.Hour).Unix(),
		})
	})
	handler.HandleFunc("/v1/network/join", func(writer http.ResponseWriter, request *http.Request) {
		coordinator.seen["join"]++
		writeAccountJSON(writer, map[string]any{
			"deviceId":  testDeviceID,
			"userId":    testUserID,
			"networkId": testNetworkID,
		})
	})
	coordinator.server = httptest.NewTLSServer(handler)
	t.Cleanup(coordinator.server.Close)
	return coordinator
}

// origin is the address the core was configured with. The identity answer has to
// echo it exactly, so it is read from the running server rather than assumed.
func (coordinator *accountCoordinator) origin() string {
	if coordinator.server == nil {
		return ""
	}
	return coordinator.server.URL
}

// endpoints are the three addresses the core validates together: the signal URL
// must be wss on the same host with path /v1/signals, and the STUN address must be
// host:port. Supplying only an origin is refused as p2p.invalid_signal_endpoint, so
// the trio is derived here rather than left partly empty.
func (coordinator *accountCoordinator) endpointsForAnswer() (string, string, string) {
	parsed, err := url.Parse(coordinator.origin())
	if err != nil || parsed.Host == "" {
		return coordinator.origin(), "", ""
	}
	return coordinator.origin(), "wss://" + parsed.Host + "/v1/signals", parsed.Host
}

func (coordinator *accountCoordinator) endpoints(t *testing.T) (string, string, string) {
	t.Helper()
	parsed, err := url.Parse(coordinator.origin())
	if err != nil || parsed.Host == "" {
		t.Fatalf("the stub coordinator has no usable origin: %v", err)
	}
	return coordinator.origin(), "wss://" + parsed.Host + "/v1/signals", parsed.Host
}

func writeAccountJSON(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(value)
}

// rootsFile writes the stub's own certificate so the core can trust it, the same
// way an operator supplies an internal CA with `serve --roots`.
func (coordinator *accountCoordinator) rootsFile(t *testing.T) string {
	t.Helper()
	certificate := coordinator.server.Certificate()
	if certificate == nil {
		t.Fatal("the stub coordinator has no certificate")
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	path := filepath.Join(t.TempDir(), "roots.pem")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	// Proves the file is a usable bundle before the core is blamed for rejecting it.
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(encoded) {
		t.Fatal("the generated roots file is not a valid PEM bundle")
	}
	return path
}

// TestHeadlessCLIRegistersLogsInAndJoins covers the three account operations over
// the CLI path, including the service-scoped envelope each one travels in.
func TestHeadlessCLIRegistersLogsInAndJoins(t *testing.T) {
	binary := cliBinary(t)
	state := stateDirectoryForCLI(t)
	coordinator := newAccountCoordinator(t)
	roots := coordinator.rootsFile(t)
	stop := startHeadlessCoreWithRoots(t, binary, state, t.TempDir(), roots)
	defer stop()

	// Before a coordinator is configured, a dispatched account method is refused for
	// the reason that is actually true: no service, not a bad request.
	_, stderr, code := runCLICommand(t, binary, "call", "user.login",
		`{"serviceId":"service_main","data":{"username":"a@b.c","password":"secret"}}`,
		"--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.service_unconfigured" {
		t.Fatalf("login before configure = %q (%d)", stderr, code)
	}

	// Configure the service against the stub. This is also the CLI path for
	// service.configure, and it reports the identity the coordinator answered with.
	origin, signals, stun := coordinator.endpoints(t)
	stdout, stderr, code := runCLICommand(t, binary, "service", "configure",
		"--origin", origin, "--wss", signals, "--stun", stun, "--state", state)
	if code != 0 {
		t.Fatalf("service configure: %s", stderr)
	}
	var configured struct {
		ServiceID string `json:"serviceId"`
	}
	if json.Unmarshal([]byte(stdout), &configured) != nil || configured.ServiceID == "" {
		t.Fatalf("service configure answered %s", stdout)
	}
	serviceID := configured.ServiceID

	// register: the coordinator creates the account and answers with the user.
	stdout, stderr, code = runCLICommand(t, binary, "call", "user.register",
		envelope(t, serviceID, map[string]any{"email": "operator@example.com", "password": "secret-value"}),
		"--state", state)
	if code != 0 {
		t.Fatalf("user.register: %s", stderr)
	}
	if !strings.Contains(stdout, "operator@example.com") {
		t.Fatalf("user.register answered %s", stdout)
	}
	if coordinator.seen["register"] != 1 {
		t.Fatalf("the coordinator saw %d register calls, want 1", coordinator.seen["register"])
	}
	// Registration is two coordinator operations, not one: /v1/register creates the
	// account and answers with the user only, so the core signs in with the same
	// credentials to hand back a usable session. Asserting it here keeps that from
	// being mistaken for a duplicate call later.
	if coordinator.seen["login"] != 1 {
		t.Fatalf("register performed %d logins, want the one that yields a session",
			coordinator.seen["login"])
	}

	// login: a separate operation, and the one that yields a usable session.
	stdout, stderr, code = runCLICommand(t, binary, "call", "user.login",
		envelope(t, serviceID, map[string]any{"username": "operator@example.com", "password": "secret-value"}),
		"--state", state)
	if code != 0 {
		t.Fatalf("user.login: %s", stderr)
	}
	if !strings.Contains(stdout, testUserID) {
		t.Fatalf("user.login answered %s", stdout)
	}
	// The second login: register's own sign-in above was the first.
	if coordinator.seen["login"] != 2 {
		t.Fatalf("the coordinator saw %d login calls, want 2", coordinator.seen["login"])
	}

	// A rejected credential reaches the terminal as a refusal, not a success with an
	// empty session.
	_, stderr, code = runCLICommand(t, binary, "call", "user.login",
		envelope(t, serviceID, map[string]any{"username": "operator@example.com", "password": "wrong-password"}),
		"--state", state)
	if code == 0 {
		t.Fatalf("a rejected login exited 0, stderr %q", stderr)
	}
	if strings.TrimSpace(stderr) == "" {
		t.Fatal("a rejected login produced no refusal code")
	}

	// network.join is dispatched through the same envelope. It needs an enrolled
	// device, so the refusal here is about enrollment rather than about the request
	// being malformed — which is exactly the distinction this task asked for.
	_, stderr, code = runCLICommand(t, binary, "call", "network.join",
		envelope(t, serviceID, map[string]any{"networkId": "network00001", "name": "headless-host"}),
		"--state", state)
	if code == 0 {
		t.Fatalf("network.join on an unenrolled host exited 0, stderr %q", stderr)
	}
	joinRefusal := strings.TrimSpace(stderr)
	if joinRefusal == "p2p.invalid_operation" {
		t.Fatal("network.join was treated as an unknown method rather than dispatched")
	}
	if joinRefusal == "" {
		t.Fatal("network.join produced no refusal code")
	}
}

// TestHeadlessCLIDistinguishesUnknownFromMalformed is the refusal distinction the
// task names: an unknown method and a dispatched one that cannot be served must not
// collapse into the same code, or an operator cannot tell a typo from a real problem.
func TestHeadlessCLIDistinguishesUnknownFromMalformed(t *testing.T) {
	binary := cliBinary(t)
	state := stateDirectoryForCLI(t)
	coordinator := newAccountCoordinator(t)
	stop := startHeadlessCoreWithRoots(t, binary, state, t.TempDir(), coordinator.rootsFile(t))
	defer stop()

	// An unknown method never reaches a service.
	_, stderr, code := runCLICommand(t, binary, "call", "user.nonexistent", `{}`, "--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.invalid_operation" {
		t.Fatalf("unknown method = %q (%d)", stderr, code)
	}

	// A published method with no configured service is a different answer.
	_, stderr, code = runCLICommand(t, binary, "call", "user.register",
		`{"serviceId":"service_main","data":{"email":"a@b.c","password":"secret-value"}}`,
		"--state", state)
	if code != 1 || strings.TrimSpace(stderr) != "p2p.service_unconfigured" {
		t.Fatalf("register with no service = %q (%d)", stderr, code)
	}

	// With a service configured, a malformed payload is refused as a bad request
	// rather than as an unknown method or an unconfigured service.
	origin, signals, stun := coordinator.endpoints(t)
	stdout, stderr, code := runCLICommand(t, binary, "service", "configure",
		"--origin", origin, "--wss", signals, "--stun", stun, "--state", state)
	if code != 0 {
		t.Fatalf("service configure: %s", stderr)
	}
	var configured struct {
		ServiceID string `json:"serviceId"`
	}
	if json.Unmarshal([]byte(stdout), &configured) != nil {
		t.Fatalf("service configure answered %s", stdout)
	}
	_, stderr, code = runCLICommand(t, binary, "call", "user.register",
		envelope(t, configured.ServiceID, map[string]any{"email": "", "password": ""}),
		"--state", state)
	if code == 0 {
		t.Fatalf("an empty registration exited 0, stderr %q", stderr)
	}
	refusal := strings.TrimSpace(stderr)
	if refusal == "p2p.invalid_operation" || refusal == "p2p.service_unconfigured" {
		t.Fatalf("a malformed request was reported as %q, which hides the real cause", refusal)
	}
}

// envelope builds the service-scoped request the host expects. Every peer operation
// travels in this shape, and getting it wrong is the CLI-specific mistake these
// tests exist to catch.
func envelope(t *testing.T, serviceID string, data map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"serviceId": serviceID, "data": data})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// startHeadlessCoreWithRoots starts a core that trusts one extra CA bundle, which is
// what lets these tests use a TLS stub coordinator instead of a public one. The core
// reads the bundle from the path it is given, exactly as an operator supplies an
// internal CA.
func startHeadlessCoreWithRoots(t *testing.T, binary string, state string, dataRoot string, roots string) func() {
	t.Helper()
	return startHeadlessCoreWithArguments(t, binary,
		"serve", "--state", state, "--data", dataRoot, "--roots", roots)
}
