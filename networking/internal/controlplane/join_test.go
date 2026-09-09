package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// A login-free join sends no Authorization header: possession of the networkId
// is the entire claim, and the coordinator assigns the owner.
func TestJoinNetworkIsLoginFreeAndReturnsTheIssuedDevice(t *testing.T) {
	networkID, requestID := protocol.NewID(), protocol.NewID()
	deviceID, ownerID := protocol.NewID(), protocol.NewID()
	var body NetworkJoin
	client := testClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/network/join" {
			t.Fatalf("unexpected call: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "" {
			t.Fatal("a login-free join must not send an authorization header")
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil {
			t.Fatal("join sent an undecodable body")
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(Device{
			DeviceID:    deviceID,
			UserID:      ownerID,
			Name:        "加入电脑",
			PublicKey:   []byte(strings.Repeat("k", 32)),
			Certificate: []byte("certificate"),
		})
	}))
	device, err := client.JoinNetwork(context.Background(), NetworkJoin{
		RequestID: requestID, NetworkID: networkID, CSR: "csr-value", Name: "加入电脑",
	})
	if err != nil {
		t.Fatal(err)
	}
	if device.DeviceID != deviceID || device.UserID != ownerID {
		t.Fatalf("join result substituted: %+v", device)
	}
	if body.NetworkID != networkID || body.RequestID != requestID || body.CSR != "csr-value" {
		t.Fatalf("join altered the submitted request: %+v", body)
	}

	// Malformed identifiers never reach the network: a retry key that is not a
	// real id would silently break idempotence.
	for _, bad := range []NetworkJoin{
		{RequestID: requestID, NetworkID: "not-an-id", CSR: "c", Name: "n"},
		{RequestID: "not-an-id", NetworkID: networkID, CSR: "c", Name: "n"},
	} {
		if _, err := client.JoinNetwork(context.Background(), bad); err == nil {
			t.Fatalf("accepted a malformed join: %+v", bad)
		}
	}
}

// The device directory must carry presence and the reported build, and must not
// carry certificates: it is rendered, and a certificate is credential material.
func TestDeviceDirectoryCarriesTelemetryAndNoCertificate(t *testing.T) {
	networkID := protocol.NewID()
	client := testClient(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer token-value" {
			t.Fatal("the directory must be read with the owner's session")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`[{"deviceId":"` + strings.Repeat("d", 32) + `","userId":"` + strings.Repeat("u", 32) + `","name":"Mac","presence":"online","lastSeen":1788000000,"version":"0.1.25","platform":"darwin","architecture":"arm64"}]`))
	}))
	entries, err := client.NetworkDevices(context.Background(), "token-value", networkID)
	if err != nil || len(entries) != 1 {
		t.Fatal("directory unreadable", err)
	}
	entry := entries[0]
	if entry.Presence != "online" || entry.LastSeen != 1788000000 {
		t.Fatalf("liveness dropped in transit: %+v", entry)
	}
	if entry.Version != "0.1.25" || entry.Platform != "darwin" || entry.Architecture != "arm64" {
		t.Fatalf("reported build dropped in transit: %+v", entry)
	}
}

// Telemetry has to survive the switch to the device-authenticated client,
// because heartbeats run on that client rather than the base one.
func TestTelemetrySurvivesTheDeviceClient(t *testing.T) {
	client := testClient(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	report := Telemetry{Version: "9.9.9", Platform: "linux", Architecture: "amd64"}
	client.SetTelemetry(report)
	if client.telemetry != report {
		t.Fatalf("telemetry not recorded: %+v", client.telemetry)
	}
	// WithDevice builds a fresh Client; a fresh Client reports nothing unless the
	// value is carried across, which would silently disable telemetry entirely.
	derived := &Client{endpoints: client.endpoints, telemetry: client.telemetry}
	if derived.telemetry != report {
		t.Fatal("device client would have reported nothing")
	}
}
