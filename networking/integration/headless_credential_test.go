package integration

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

	// The catalog is what records which services this machine knows, and the
	// headless restore reads it to learn which credentials to look for. The shell
	// enables it on first use; a headless run has to be given the same start.
	if _, stderr, code := runCLICommand(t, binary, "call", "core.catalog_enable", "{}",
		"--state", state); code != 0 {
		stop()
		t.Fatalf("core.catalog_enable: %s", stderr)
	}

	// Configure against the real coordinator, which also records the service in the
	// catalog the headless restore later reads.
	stdout, stderr, code := runCLICommand(t, binary, "service", "configure",
		"--origin", f.endpoints.HTTPSOrigin, "--wss", f.endpoints.WSSURL,
		"--stun", f.endpoints.STUNAddress, "--state", state)
	if code != 0 {
		stop()
		t.Fatalf("service configure: %s", stderr)
	}
	var configured struct {
		ServiceID string `json:"serviceId"`
	}
	if json.Unmarshal([]byte(stdout), &configured) != nil || configured.ServiceID == "" {
		stop()
		t.Fatalf("service configure answered %s", stdout)
	}
	serviceID := configured.ServiceID

	// Hand over a credential the coordinator really issued, which is what a desktop
	// does on the first launch after updating. The core has to take ownership of it
	// here; that is what makes the second run possible at all.
	device := f.config[0].Device
	restorePayload := envelope(t, serviceID, map[string]any{
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
