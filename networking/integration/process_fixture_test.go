package integration

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

type process struct {
	cmd  *exec.Cmd
	done chan error
}

func launch(t *testing.T, cmd *exec.Cmd) *process {
	t.Helper()
	must(t, cmd.Start())
	p := &process{cmd: cmd, done: make(chan error, 1)}
	go func() { p.done <- cmd.Wait(); close(p.done) }()
	t.Cleanup(func() { p.stop(t, false) })
	return p
}
func (p *process) stop(t *testing.T, abrupt bool) {
	t.Helper()
	select {
	case <-p.done:
		return
	default:
	}
	graceful := !abrupt
	if graceful {
		// EOF on the control pipe is the cross-platform graceful-stop
		// contract for children that read commands from stdin.
		if stdin, piped := p.cmd.Stdin.(io.Closer); piped {
			_ = stdin.Close()
			_ = p.cmd.Process.Signal(os.Interrupt)
		} else if runtime.GOOS == "windows" {
			// os.Interrupt is not deliverable to child processes on Windows
			// (Process.Signal there supports Kill only). Piped children stop
			// on the stdin EOF above; unpiped ones (the coordinator)
			// terminate directly instead of waiting out the grace period.
			graceful = false
		} else {
			_ = p.cmd.Process.Signal(os.Interrupt)
		}
	}
	if !graceful {
		must(t, p.cmd.Process.Kill())
	}
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
		t.Error("process failed to stop within 5 seconds")
	}
}

type fixture struct {
	binary, configPath string
	root               []byte
	endpoints          controlplane.Endpoints
	client             *controlplane.Client
	authority          controlplane.Identity
	config             [2]childConfig
	devices            [2]*controlplane.Client
	server             *process
	ctx                context.Context
	userSession        controlplane.UserSession
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	binary := os.Getenv("DSHKER_SERVER_BINARY")
	if !filepath.IsAbs(binary) {
		t.Fatal("set DSHKER_SERVER_BINARY to the explicitly built production server binary")
	}
	info, err := os.Stat(binary)
	must(t, err)
	if !info.Mode().IsRegular() {
		t.Fatal("server binary is not a regular file")
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	directory := t.TempDir()
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	tcpAddress := tcp.Addr().String()
	must(t, tcp.Close())
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	must(t, err)
	udpAddress := udp.LocalAddr().String()
	must(t, udp.Close())
	public, private, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "DSHKer process test"}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	must(t, err)
	key, err := x509.MarshalPKCS8PrivateKey(private)
	must(t, err)
	endpoints := controlplane.Endpoints{HTTPSOrigin: "https://" + tcpAddress, WSSURL: "wss://" + tcpAddress + "/v1/signals", STUNAddress: udpAddress}
	config := map[string]string{"httpsOrigin": endpoints.HTTPSOrigin, "wssUrl": endpoints.WSSURL, "stunAddress": udpAddress, "httpsListen": tcpAddress, "stunListen": udpAddress, "tlsCertPath": filepath.Join(directory, "tls.crt"), "tlsKeyPath": filepath.Join(directory, "tls.key"), "databasePath": filepath.Join(directory, "state.db"), "identityKeyPath": filepath.Join(directory, "identity.key"), "turnSharedSecret": "process-test-relay-secret-0123456789abcdef0000", "relayPublicIP": "127.0.0.1"}
	data, err := json.Marshal(config)
	must(t, err)
	configPath := filepath.Join(directory, "config.json")
	for path, value := range map[string][]byte{configPath: data, config["tlsCertPath"]: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), config["tlsKeyPath"]: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})} {
		must(t, os.WriteFile(path, value, 0600))
	}
	must(t, exec.CommandContext(ctx, binary, "init", "--config", configPath).Run())
	password := protocol.NewID() + protocol.NewID()
	create := exec.CommandContext(ctx, binary, "user-add", "--config", configPath, "--username", "process@test.local")
	create.Stdin = strings.NewReader(password + "\n")
	must(t, create.Run())
	cert, err := x509.ParseCertificate(der)
	must(t, err)
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	client, err := controlplane.New(endpoints, roots)
	must(t, err)
	t.Cleanup(client.Close)
	f := &fixture{binary: binary, configPath: configPath, root: der, endpoints: endpoints, client: client, ctx: ctx}
	f.startServer(t)
	session, err := client.Login(ctx, "process@test.local", password)
	must(t, err)
	f.userSession = session
	network, err := client.CreateNetwork(ctx, session.Token, "two-process-network")
	must(t, err)
	for i := range 2 {
		grant, err := client.EnrollmentToken(ctx, session.Token, network.NetworkID)
		must(t, err)
		private, csr, err := controlplane.NewDeviceKey()
		must(t, err)
		device, err := client.Enroll(ctx, controlplane.Enrollment{RequestID: protocol.NewID(), Token: grant.Token, CSR: csr, Name: []string{"process-A", "process-B"}[i]})
		must(t, err)
		f.devices[i], err = client.WithDevice(device, private, f.authority)
		must(t, err)
		t.Cleanup(f.devices[i].Close)
		f.config[i] = childConfig{Endpoints: endpoints, Root: der, Authority: f.authority, Device: device, Private: private}
	}
	share, err := f.devices[1].Share(ctx, network.NetworkID)
	must(t, err)
	encoded, err := json.Marshal(share)
	must(t, err)
	code := base64.RawURLEncoding.EncodeToString(encoded)
	_, err = controlplane.VerifyShare(code, f.authority, network.NetworkID, f.config[0].Device.DeviceID, time.Now())
	must(t, err)
	pair, err := f.devices[0].Invite(ctx, code)
	must(t, err)
	_, err = f.devices[1].PairAction(ctx, pair.PairID, "approve", "")
	must(t, err)
	_, err = f.devices[0].PairAction(ctx, pair.PairID, "confirm", share.Fingerprint)
	must(t, err)
	for i := range 2 {
		f.config[i].Pin, err = f.devices[i].PairIdentity(ctx, pair.PairID)
		must(t, err)
	}
	if f.config[0].Device.DeviceID == f.config[1].Device.DeviceID || f.config[0].Pin.Pair != f.config[1].Pin.Pair {
		t.Fatal("independent device/pair readback failed")
	}
	return f
}
func (f *fixture) startServer(t *testing.T) {
	f.server = launch(t, exec.CommandContext(f.ctx, f.binary, "serve", "--config", f.configPath))
	var err error
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		var identity controlplane.Identity
		identity, err = f.client.Identity(f.ctx, f.authority.PublicKey)
		if err == nil {
			f.authority = identity
			return
		}
		select {
		case <-f.server.done:
			t.Fatal("production coordinator exited during startup")
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatalf("production coordinator startup failed: %v", err)
}

type child struct {
	process *process
	input   io.WriteCloser
	output  chan result
	pending []result
	nextID  int
}

func startChild(t *testing.T, config childConfig) *child {
	t.Helper()
	binary, err := os.Executable()
	must(t, err)
	cmd := exec.Command(binary, "-test.run=^TestPeerProcess$")
	cmd.Env = append(os.Environ(), "DSHKER_TEST_PEER_PROCESS=1")
	stdin, err := cmd.StdinPipe()
	must(t, err)
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	// Race detector diagnostics must be visible; no keys, tokens or SDP are logged.
	cmd.Stderr = os.Stderr
	c := &child{input: stdin, output: make(chan result, 256)}
	c.process = launch(t, cmd)
	t.Cleanup(func() { stdin.Close() })
	go func() {
		defer close(c.output)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var value result
			if json.Unmarshal(scanner.Bytes(), &value) != nil {
				continue
			}
			c.output <- value
		}
	}()
	value := c.call(t, command{Op: "init", Config: &config})
	if value.PID != c.process.cmd.Process.Pid {
		t.Fatal("peer process PID readback mismatch")
	}
	return c
}
func (c *child) request(t *testing.T, input command) result {
	t.Helper()
	c.nextID++
	input.ID = c.nextID
	must(t, json.NewEncoder(c.input).Encode(input))
	return c.wait(t, func(value result) bool { return value.ID == input.ID }, 35*time.Second)
}
func (c *child) call(t *testing.T, input command) result {
	t.Helper()
	value := c.request(t, input)
	if value.Error != "" {
		t.Fatalf("peer operation %s: %s", input.Op, value.Error)
	}
	return value
}
func (c *child) wait(t *testing.T, accept func(result) bool, budget time.Duration) result {
	t.Helper()
	for i, value := range c.pending {
		if accept(value) {
			c.pending = append(c.pending[:i], c.pending[i+1:]...)
			return value
		}
	}
	timer := time.NewTimer(budget)
	defer timer.Stop()
	for {
		select {
		case value, ok := <-c.output:
			if !ok {
				t.Fatal("peer test process exited")
			}
			if accept(value) {
				return value
			}
			if value.Event == "fatal" || value.Event == "signal-error" || value.Event == "failed" {
				t.Fatalf("peer event %s: %s", value.Event, value.Error)
			}
			c.pending = append(c.pending, value)
		case <-timer.C:
			t.Fatalf("peer event timed out after %s; pending event count %d", budget, len(c.pending))
		}
	}
}

func connect(t *testing.T, a, b *child, generation uint64) string {
	t.Helper()
	value := a.call(t, command{Op: "connect", Generation: generation})
	for _, c := range []*child{a, b} {
		ready := c.wait(t, func(event result) bool { return event.Event == "ready" && event.Attempt == value.Attempt }, 30*time.Second)
		if ready.Path.Protocol != "udp" || ready.Path.LocalType == "relay" || ready.Path.RemoteType == "relay" || ready.Path.LocalType == "" || ready.Path.RemoteType == "" {
			t.Fatal("no authenticated direct UDP candidate pair")
		}
	}
	return value.Attempt
}
