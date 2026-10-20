package integration

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
)

// An enrolled machine has to come back as its own device with no desktop attached.
//
// This is the failure the test exists for. The core minted and kept the machine's
// private key, but the record naming what that key was enrolled as — the
// coordinator-issued device id, the signed certificate, the account it belongs to —
// was handed to the desktop and kept only there, encrypted with a key only Electron
// can use. `dshkerd serve` therefore published its endpoint, answered every method
// and was nobody: no coordinator subscription, no presence, and every attempt
// toward it saw an offline peer while the machine looked installed. Restarting
// changed nothing, because there was nothing it could read to learn its identity.
//
// The test uses the production coordinator and a real `dshkerd serve` process. A
// first run is handed a credential the way a desktop hands one over; a second run
// on the same directories gets no client at all and must restore that device by
// itself, which is what proves the credential belongs to the core.
func TestHeadlessCoreRestoresItsOwnCredential(t *testing.T) {
	f := newFixture(t)
	binary := cliBinary(t)
	state := stateDirectoryForCLI(t)
	dataRoot := t.TempDir()
	catalogRoot := t.TempDir()
	rootsPath := filepath.Join(t.TempDir(), "roots.pem")
	writeRootsPEM(t, rootsPath, f.root)

	stop := startHeadlessCoreWithArguments(t, binary,
		"serve", "--state", state, "--data", dataRoot,
		"--catalog", catalogRoot, "--roots", rootsPath)

	// Configure verifies the running coordinator. Catalog registration is a
	// separate public operation, just as it is when the desktop adds a service.
	stdout, stderr, code := runCLICommand(t, binary, "service", "configure",
		"--origin", f.endpoints.HTTPSOrigin, "--wss", f.endpoints.WSSURL,
		"--stun", f.endpoints.STUNAddress, "--state", state)
	if code != 0 {
		stop()
		t.Fatalf("service configure: %s", stderr)
	}
	var configured controlplane.Identity
	if json.Unmarshal([]byte(stdout), &configured) != nil || configured.ServiceID == "" {
		stop()
		t.Fatalf("service configure answered %s", stdout)
	}
	serviceID := configured.ServiceID
	registerHeadlessCatalogService(t, binary, state, f, configured)
	// Initial setup supplies the real issued login independently of device owner.
	sessionRecord := integrationSessionRecord(t, f.userSession)
	secretPayload, err := json.Marshal(map[string]string{
		"key":   "peer-user-session:" + serviceID,
		"value": base64.StdEncoding.EncodeToString(sessionRecord),
	})
	must(t, err)
	if _, stderr, code = runCLICommand(t, binary, "call", "core.secret_set", string(secretPayload), "--state", state); code != 0 {
		stop()
		t.Fatalf("initial session import failed: %s", stderr)
	}
	if _, stderr, code = runCLICommand(t, binary, "call", "user.current", envelope(t, serviceID, map[string]any{"token": f.userSession.Token}), "--state", state); code != 0 {
		stop()
		t.Fatalf("initial current account confirmation failed: %s", stderr)
	}

	// Hand over a credential the coordinator really issued, which is what a desktop
	// does on the first launch after updating. The core has to take ownership of it
	// here; that is what makes the second run possible at all.
	device := f.config[0].Device
	restorePayload := envelope(t, serviceID, map[string]any{
		"accountUserId": f.userSession.User.UserID,
		"device": map[string]any{
			"deviceId":    device.DeviceID,
			"userId":      device.UserID,
			"name":        device.Name,
			"publicKey":   base64.StdEncoding.EncodeToString(device.PublicKey),
			"certificate": base64.StdEncoding.EncodeToString(device.Certificate),
		},
		"privateKey": base64.StdEncoding.EncodeToString(f.config[0].Private),
		"pins":       []any{},
	})
	if _, stderr, code = runCLICommand(t, binary, "call", "device.restore",
		restorePayload, "--state", state); code != 0 {
		stop()
		t.Fatalf("device.restore: %s", stderr)
	}
	stop()

	// The second run is the whole point: same directories, no desktop, no client
	// driving it. It has to come up as the device the first run was handed.
	restarted := startHeadlessCoreWithArguments(t, binary,
		"serve", "--state", state, "--data", dataRoot,
		"--catalog", catalogRoot, "--roots", rootsPath)
	defer restarted()

	// A restored account answers this; an unrestored one refuses with
	// p2p.service_unconfigured, which is what the second run used to do.
	deadline := time.Now().Add(20 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		stdout, stderr, code = runCLICommand(t, binary, "call", "directory.inspect",
			envelope(t, serviceID, map[string]any{}), "--state", state)
		if code == 0 && !strings.Contains(stdout, "device_unregistered") {
			return
		}
		last = strings.TrimSpace(stderr + stdout)
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("the restarted core never restored its own device: %s", last)
}

// Register only the coordinator that service.configure verified. The CLI's
// published catalog operations own this initial setup; restart must restore it.
func registerHeadlessCatalogService(t *testing.T, binary, state string, f *fixture, identity controlplane.Identity) {
	t.Helper()
	service := catalog.Service{
		ServiceID: identity.ServiceID, DisplayName: "integration-coordinator",
		HTTPSOrigin: identity.HTTPSOrigin, WSSURL: identity.WSSURL, STUNAddress: identity.STUNAddress,
		PublicKey: base64.StdEncoding.EncodeToString(identity.PublicKey), Certificate: base64.StdEncoding.EncodeToString(identity.Certificate),
	}
	if service != integrationCatalogService(f) {
		t.Fatal("service.configure did not return the real coordinator identity and endpoints")
	}
	stdout, stderr, code := runCLICommand(t, binary, "call", "core.catalog_enable", "{}", "--state", state)
	if code != 0 {
		t.Fatalf("core.catalog_enable: %s", stderr)
	}
	type catalogView struct {
		Enabled  bool           `json:"enabled"`
		Revision string         `json:"revision"`
		Record   catalog.Record `json:"record"`
	}
	var enabled catalogView
	must(t, json.Unmarshal([]byte(stdout), &enabled))
	if !enabled.Enabled || enabled.Revision == "" || enabled.Record.CatalogID == "" || len(enabled.Record.Services) != 0 || len(enabled.Record.Computers) != 0 || len(enabled.Record.ForgottenServiceIDs) != 0 {
		t.Fatal("initial headless catalog is not an enabled, empty record")
	}
	record := enabled.Record
	record.Services = []catalog.Service{service}
	payload, err := json.Marshal(map[string]any{"expectedRevision": enabled.Revision, "record": record})
	must(t, err)
	stdout, stderr, code = runCLICommand(t, binary, "call", "core.catalog_commit", string(payload), "--state", state)
	if code != 0 {
		t.Fatalf("core.catalog_commit: %s", stderr)
	}
	var committed catalogView
	must(t, json.Unmarshal([]byte(stdout), &committed))
	if !committed.Enabled || committed.Revision == "" || committed.Revision == enabled.Revision || !reflect.DeepEqual(committed.Record, record) {
		t.Fatal("catalog commit did not record the exact verified service")
	}
	stdout, stderr, code = runCLICommand(t, binary, "call", "core.catalog_inspect", "{}", "--state", state)
	if code != 0 {
		t.Fatalf("core.catalog_inspect: %s", stderr)
	}
	var readback catalogView
	must(t, json.Unmarshal([]byte(stdout), &readback))
	if !reflect.DeepEqual(readback, committed) {
		t.Fatal("headless catalog readback differs from the committed service and revision")
	}
}

// writeRootsPEM publishes the coordinator's certificate as the trust anchor the
// core is started with, the way an operator supplies an internal CA.
func writeRootsPEM(t *testing.T, path string, der []byte) {
	t.Helper()
	body := base64.StdEncoding.EncodeToString(der)
	encoded := "-----BEGIN CERTIFICATE-----\n"
	for len(body) > 64 {
		encoded += body[:64] + "\n"
		body = body[64:]
	}
	encoded += body + "\n-----END CERTIFICATE-----\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
}
