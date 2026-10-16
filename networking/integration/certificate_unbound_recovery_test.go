package integration

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Independent grants exercise the real public TLS recovery route without
// OS credentials, a daemon, a desktop, or a substitute coordinator.
func TestCertificateRealCoordinatorUnboundRecovery(t *testing.T) {
	for _, linked := range []bool{false, true} {
		name := "original-owner"
		if linked {
			name = "linked-account"
		}
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			session := f.userSession
			if linked {
				session = certificateUnboundLinkedAccount(t, f)
			}
			network, err := f.client.CreateNetwork(f.ctx, session.Token, "existing-unbound-recovery-network")
			must(t, err)
			expired := setCoordinatorCertificateTime(t, f, -10*time.Second)
			serverLog := certificateUnboundCaptureServer(t, f)
			ownership := certificateUnboundOwnership(t, f)
			before := certificateUnboundCounts(t, f)
			grant, err := f.client.EnrollmentToken(f.ctx, session.Token, network.NetworkID)
			must(t, err)
			trace := &certificateUnboundTrace{}
			ctx := httptrace.WithClientTrace(f.ctx, trace.callbacks())
			started := time.Now()
			_, err = f.client.RecoverCertificate(ctx, expired, f.config[0].Private, f.authority, protocol.NewID(), grant.Token)
			t.Logf("recovery_error=%v elapsed=%s transport=%s", err, time.Since(started), trace.snapshot())
			if err == nil || err.Error() != "p2p.binding_unauthorized" {
				certificateUnboundHTTPProbe(t, f, expired, grant.Token)
				certificateUnboundServerLog(t, serverLog)
				t.Fatalf("unbound recovery=%v, want p2p.binding_unauthorized", err)
			}
			actual, err := f.client.ReadCertificate(f.ctx, expired.DeviceID, f.config[0].Private, f.authority)
			must(t, err)
			if !reflect.DeepEqual(actual, expired) || !reflect.DeepEqual(certificateUnboundOwnership(t, f), ownership) {
				t.Fatal("unbound recovery changed original device, account, certificate, network, binding or pair")
			}
			after := certificateUnboundCounts(t, f)
			if after.Grants != before.Grants+1 || after.Used != before.Used || after.Renewals != before.Renewals {
				t.Fatalf("unbound recovery consumed a grant or issued a certificate: before=%+v after=%+v", before, after)
			}
			certificateUnboundServerLog(t, serverLog)
		})
	}
}

func certificateUnboundLinkedAccount(t *testing.T, f *realCoordinator) controlplane.UserSession {
	t.Helper()
	password := protocol.NewID() + protocol.NewID()
	user, err := f.client.Register(f.ctx, "unbound-linked@test.local", password)
	must(t, err)
	session, err := f.client.Login(f.ctx, user.Username, password)
	must(t, err)
	network, err := f.client.CreateNetwork(f.ctx, session.Token, "existing-linked-network")
	must(t, err)
	csr, err := controlplane.DeviceCSR(f.config[0].Private)
	must(t, err)
	joined, err := f.client.JoinNetwork(f.ctx, controlplane.NetworkJoin{RequestID: protocol.NewID(), NetworkID: network.NetworkID, CSR: csr, Name: f.config[0].Device.Name})
	must(t, err)
	if joined.DeviceID != f.config[0].Device.DeviceID || !bytes.Equal(joined.PublicKey, f.config[0].Device.PublicKey) || session.User.UserID == f.config[0].Device.UserID {
		t.Fatal("linked account setup did not retain the original device under a distinct account")
	}
	return session
}

func certificateUnboundCaptureServer(t *testing.T, f *realCoordinator) string {
	t.Helper()
	f.server.stop(t, false)
	file, err := os.CreateTemp(t.TempDir(), "coordinator-stderr-")
	must(t, err)
	t.Cleanup(func() { file.Close() })
	command := exec.CommandContext(f.ctx, f.binary, "serve", "--config", f.configPath)
	command.Stderr = file
	f.server = launch(t, command)
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		_, err = f.client.Identity(f.ctx, f.authority.PublicKey)
		if err == nil {
			return file.Name()
		}
		select {
		case <-f.server.done:
			certificateUnboundServerLog(t, file.Name())
			t.Fatal("isolated coordinator exited during diagnostic startup")
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatalf("isolated coordinator diagnostic startup failed: %v", err)
	return ""
}

func certificateUnboundServerLog(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Logf("isolated server stderr read error=%v", err)
		return
	}
	// The production server writes only error codes and standard net/http TLS
	// diagnostics here. Never print request bodies or unrestricted log content.
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	accepted := 0
	for _, line := range lines {
		if strings.Contains(line, "http: TLS handshake error") || strings.HasPrefix(line, "p2p.") {
			t.Logf("isolated server stderr: %s", line)
			accepted++
		}
	}
	t.Logf("isolated server stderr bytes=%d accepted_lines=%d", len(data), accepted)
}

type certificateUnboundTrace struct {
	mu                   sync.Mutex
	connected, reused    bool
	handshake, firstByte bool
	tlsError, writeError error
}

func (trace *certificateUnboundTrace) callbacks() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.connected, trace.reused = true, info.Reused
		},
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.handshake, trace.tlsError = true, err
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.writeError = info.Err
		},
		GotFirstResponseByte: func() {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.firstByte = true
		},
	}
}

func (trace *certificateUnboundTrace) snapshot() string {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	data, _ := json.Marshal(map[string]any{"connected": trace.connected, "reused": trace.reused, "handshake": trace.handshake, "firstByte": trace.firstByte, "tlsError": certificateUnboundError(trace.tlsError), "writeError": certificateUnboundError(trace.writeError)})
	return string(data)
}

func certificateUnboundError(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type certificateUnboundIssuance struct {
	Grants   int `json:"grants"`
	Used     int `json:"used"`
	Renewals int `json:"renewals"`
}

func certificateUnboundCounts(t *testing.T, f *realCoordinator) certificateUnboundIssuance {
	t.Helper()
	var rows []certificateUnboundIssuance
	must(t, json.Unmarshal(certificateUnboundQuery(t, f, "SELECT (SELECT count(*) FROM tokens) AS grants,(SELECT coalesce(sum(used),0) FROM tokens) AS used,(SELECT count(*) FROM renewals) AS renewals"), &rows))
	if len(rows) != 1 {
		t.Fatal("isolated coordinator returned no issuance accounting row")
	}
	return rows[0]
}

func certificateUnboundOwnership(t *testing.T, f *realCoordinator) map[string]string {
	t.Helper()
	queries := map[string]string{
		"users":        "SELECT id,email,disabled FROM users ORDER BY id",
		"devices":      "SELECT id,user_id,hex(public_key) AS public_key,name,hex(certificate) AS certificate,revoked,request_id FROM devices ORDER BY id",
		"networks":     "SELECT id,user_id,name,deleted,max_devices FROM networks ORDER BY id",
		"device_users": "SELECT device_id,user_id FROM device_users ORDER BY device_id,user_id",
		"bindings":     "SELECT network_id,device_id,active FROM bindings ORDER BY network_id,device_id",
		"pairs":        "SELECT id,network_id,initiator,target,state,expires,revision FROM pairs ORDER BY id",
	}
	rows := make(map[string]string, len(queries))
	for table, query := range queries {
		rows[table] = string(certificateUnboundQuery(t, f, query))
	}
	return rows
}

func certificateUnboundQuery(t *testing.T, f *realCoordinator, query string) []byte {
	t.Helper()
	data, err := os.ReadFile(f.configPath)
	must(t, err)
	var config map[string]string
	must(t, json.Unmarshal(data, &config))
	output, err := exec.CommandContext(f.ctx, "sqlite3", "-readonly", "-batch", "-json", config["databasePath"], query).Output()
	must(t, err)
	return output
}

func certificateUnboundHTTPProbe(t *testing.T, f *realCoordinator, device controlplane.Device, token string) {
	t.Helper()
	csr, err := controlplane.DeviceCSR(f.config[0].Private)
	must(t, err)
	body, err := json.Marshal(map[string]string{"deviceId": device.DeviceID, "requestId": protocol.NewID(), "csr": csr, "token": token})
	must(t, err)
	defer clear(body)
	root, err := x509.ParseCertificate(f.root)
	must(t, err)
	roots := x509.NewCertPool()
	roots.AddCert(root)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}, MaxResponseHeaderBytes: 16 * 1024}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.endpoints.HTTPSOrigin+"/v1/recover-certificate", bytes.NewReader(body))
	must(t, err)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Logf("direct unbound recovery HTTP transport error=%v", err)
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, protocol.MaxControlBytes+1))
	defer clear(data)
	if err != nil || len(data) > protocol.MaxControlBytes {
		t.Logf("direct unbound recovery HTTP status=%d protocol=%s body_read_error=%v", response.StatusCode, response.Proto, err)
		return
	}
	var failure struct {
		Code string `json:"code"`
	}
	if protocol.DecodeExact(data, &failure) != nil || !strings.HasPrefix(failure.Code, "p2p.") || strings.ContainsAny(failure.Code, " \r\n\t") {
		t.Logf("direct unbound recovery HTTP status=%d protocol=%s invalid_error_schema=true", response.StatusCode, response.Proto)
		return
	}
	t.Logf("direct unbound recovery HTTP status=%d protocol=%s error=%s", response.StatusCode, response.Proto, failure.Code)
}
