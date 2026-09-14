package remoteroute

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// One generation's timings. They are the shell's own numbers: a ten second
// window for a forward to accept its first connection, and seventy seconds for
// the broker to hand back a session, because it may have to start DSH first.
const (
	processReadyTimeout = 10 * time.Second
	peerRequestTimeout  = 70 * time.Second
	forwardProbeEvery   = 50 * time.Millisecond
	stopGracePeriod     = 3 * time.Second
)

// Tunnel is one supervised forwarding process.
type Tunnel interface {
	Exited() <-chan struct{}
	Stderr() string
	Stop() error
}

// Connector owns every operation one generation needs. A zero value uses the
// production implementations; the tests replace them so the decision path can be
// driven without OpenSSH or a remote machine.
type Connector struct {
	Executables        Executables
	Platform           string
	RunSCP             func(ctx context.Context, executable string, args []string) error
	SpawnTunnel        func(executable string, args []string) (Tunnel, error)
	WaitForward        func(ctx context.Context, tunnel Tunnel, port int) error
	ReservePort        func() (int, error)
	RequestRuntime     func(ctx context.Context, port int, secret string) (string, error)
	TemporaryDirectory func() (string, error)
	ReadFile           func(path string) ([]byte, error)
	RemoveAll          func(path string) error
}

// defaultPlatform reports the host this build runs on.
func defaultPlatform() string { return runtime.GOOS }

func (connector Connector) resolved() Connector {
	if connector.Platform == "" {
		connector.Platform = defaultPlatform()
	}
	if connector.Executables.SSH == "" && connector.Executables.SCP == "" {
		connector.Executables = ResolveExecutables(connector.Platform)
	}
	if connector.RunSCP == nil {
		connector.RunSCP = runSCP
	}
	if connector.SpawnTunnel == nil {
		connector.SpawnTunnel = spawnTunnel
	}
	if connector.WaitForward == nil {
		connector.WaitForward = waitForForward
	}
	if connector.ReservePort == nil {
		connector.ReservePort = reserveLoopbackPort
	}
	if connector.RequestRuntime == nil {
		connector.RequestRuntime = requestRemoteRuntime
	}
	if connector.TemporaryDirectory == nil {
		connector.TemporaryDirectory = temporaryDirectory
	}
	if connector.ReadFile == nil {
		connector.ReadFile = os.ReadFile
	}
	if connector.RemoveAll == nil {
		connector.RemoveAll = func(path string) error { return os.RemoveAll(path) }
	}
	return connector
}

// Connect runs one full generation and returns the local URL that carries the
// remote session. onUnexpectedExit is called when either forward dies after the
// generation was handed out, so the caller can retire it instead of serving a
// dead address.
func (connector Connector) Connect(ctx context.Context, computer Computer, onUnexpectedExit func()) (string, func(), error) {
	if err := AssertComputer(computer); err != nil {
		return "", nil, err
	}
	active := connector.resolved()
	directory, err := active.TemporaryDirectory()
	if err != nil {
		return "", nil, fmt.Errorf("%w: SSH tunnel setup failed.", ErrTunnelFailed)
	}
	defer func() { _ = active.RemoveAll(directory) }()
	descriptorPath := filepath.Join(directory, DescriptorFileName)
	var brokerTunnel, runtimeTunnel Tunnel
	stop := func() {
		if brokerTunnel != nil {
			_ = brokerTunnel.Stop()
		}
		if runtimeTunnel != nil {
			_ = runtimeTunnel.Stop()
		}
	}
	fail := func(err error) (string, func(), error) {
		stop()
		if errors.Is(err, ErrUnavailable) || errors.Is(err, ErrAuthenticationFailed) ||
			errors.Is(err, ErrPeerUnavailable) || errors.Is(err, ErrPeerAuthentication) ||
			errors.Is(err, ErrPeerProtocolInvalid) || errors.Is(err, ErrTunnelFailed) {
			return "", nil, err
		}
		return "", nil, fmt.Errorf("%w: SSH tunnel setup failed.", ErrTunnelFailed)
	}
	if err := active.RunSCP(ctx, active.Executables.SCP, BuildScpArguments(computer, descriptorPath)); err != nil {
		return fail(err)
	}
	descriptor, err := ParseDescriptor(mustReadFile(active, descriptorPath))
	if err != nil {
		return fail(err)
	}
	if ctx.Err() != nil {
		return fail(fmt.Errorf("%w: the remote connection was cancelled.", ErrTunnelFailed))
	}

	brokerPort, err := active.ReservePort()
	if err != nil {
		return fail(fmt.Errorf("%w: no loopback port could be reserved.", ErrTunnelFailed))
	}
	brokerTunnel, err = active.SpawnTunnel(active.Executables.SSH, BuildSshForwardArguments(computer, brokerPort, descriptor.Port))
	if err != nil {
		return fail(fmt.Errorf("%w: the OpenSSH tunnel executable is unavailable.", ErrUnavailable))
	}
	if err := active.WaitForward(ctx, brokerTunnel, brokerPort); err != nil {
		return fail(err)
	}
	remoteURL, err := active.RequestRuntime(ctx, brokerPort, descriptor.Secret)
	if err != nil {
		return fail(err)
	}
	accepted, remoteRuntimePort, err := ParseRuntimeURL(remoteURL)
	if err != nil {
		return fail(err)
	}
	runtimePort, err := active.ReservePort()
	if err != nil {
		return fail(fmt.Errorf("%w: no loopback port could be reserved.", ErrTunnelFailed))
	}
	runtimeTunnel, err = active.SpawnTunnel(active.Executables.SSH, BuildSshForwardArguments(computer, runtimePort, remoteRuntimePort))
	if err != nil {
		return fail(fmt.Errorf("%w: the OpenSSH tunnel executable is unavailable.", ErrUnavailable))
	}
	if err := active.WaitForward(ctx, runtimeTunnel, runtimePort); err != nil {
		return fail(err)
	}
	mapped, err := MapLoopback(accepted, runtimePort)
	if err != nil {
		return fail(err)
	}
	retired := make(chan struct{})
	go func() {
		select {
		case <-brokerTunnel.Exited():
		case <-runtimeTunnel.Exited():
		case <-retired:
			return
		}
		select {
		case <-retired:
		default:
			onUnexpectedExit()
		}
	}()
	return mapped, func() {
		close(retired)
		stop()
	}, nil
}

// mustReadFile reads the descriptor the transfer just delivered. A read failure
// is the transfer's failure, not a protocol problem.
func mustReadFile(connector Connector, path string) []byte {
	data, err := connector.ReadFile(path)
	if err != nil {
		return nil
	}
	return data
}

// runSCP performs the descriptor transfer and classifies its failure the way the
// shell did: an authentication or host-key refusal is its own code, and anything
// else means the peer did not deliver a descriptor.
func runSCP(ctx context.Context, executable string, args []string) error {
	command := exec.CommandContext(ctx, executable, args...)
	stderr := &boundedBuffer{limit: 4096}
	command.Stderr = stderr
	command.Stdout = io.Discard
	if err := command.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return fmt.Errorf("%w: OpenSSH file transfer is unavailable.", ErrUnavailable)
		}
		if classified := ClassifySSHFailure(stderr.String()); classified != nil {
			return classified
		}
		return fmt.Errorf("%w: the remote DSHKer peer descriptor is unavailable.", ErrPeerUnavailable)
	}
	return nil
}

// spawnTunnel starts one forwarding process in its own group on POSIX, so a stop
// reaches the whole tree rather than only the ssh client.
func spawnTunnel(executable string, args []string) (Tunnel, error) {
	command := exec.Command(executable, args...)
	command.SysProcAttr = tunnelProcessAttributes()
	stderr := &boundedBuffer{limit: 4096}
	command.Stderr = stderr
	command.Stdout = io.Discard
	if err := command.Start(); err != nil {
		return nil, err
	}
	active := &processTunnel{command: command, stderr: stderr, exited: make(chan struct{})}
	go func() {
		_ = command.Wait()
		close(active.exited)
	}()
	return active, nil
}

type processTunnel struct {
	command *exec.Cmd
	stderr  *boundedBuffer
	exited  chan struct{}
}

func (tunnel *processTunnel) Exited() <-chan struct{} { return tunnel.exited }

func (tunnel *processTunnel) Stderr() string { return tunnel.stderr.String() }

func (tunnel *processTunnel) Stop() error {
	select {
	case <-tunnel.exited:
		return nil
	default:
	}
	_ = terminateTunnelTree(tunnel.command)
	select {
	case <-tunnel.exited:
	case <-time.After(stopGracePeriod):
	}
	return nil
}

// waitForForward waits until the forward accepts one loopback connection, and
// reports the exit reason when the process dies first.
func waitForForward(ctx context.Context, tunnel Tunnel, port int) error {
	deadline := time.Now().Add(processReadyTimeout)
	for {
		select {
		case <-tunnel.Exited():
			if classified := ClassifySSHFailure(tunnel.Stderr()); classified != nil {
				return classified
			}
			return fmt.Errorf("%w: SSH port forwarding failed.", ErrTunnelFailed)
		default:
		}
		if err := probeLoopback(port); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w: SSH port forwarding did not become ready.", ErrTunnelFailed)
		}
		if ctx.Err() != nil {
			return fmt.Errorf("%w: the remote connection was cancelled.", ErrTunnelFailed)
		}
		time.Sleep(forwardProbeEvery)
	}
}

func probeLoopback(port int) error {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), forwardProbeEvery)
	if err != nil {
		return err
	}
	return conn.Close()
}

// reserveLoopbackPort reserves one port by binding it and releasing it again,
// which is what the shell did before handing the number to ssh.
func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return 0, errors.New("no loopback port was reserved")
	}
	port := address.Port
	_ = listener.Close()
	return port, nil
}

// requestRemoteRuntime asks the forwarded broker for one DSH session.
func requestRemoteRuntime(ctx context.Context, port int, secret string) (string, error) {
	budget, cancel := context.WithTimeout(ctx, peerRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(budget, http.MethodPost,
		"http://127.0.0.1:"+strconv.Itoa(port)+"/v1/runtime/connect", nil)
	if err != nil {
		return "", fmt.Errorf("%w: the remote DSHKer peer endpoint is unavailable.", ErrPeerUnavailable)
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	client := &http.Client{Timeout: peerRequestTimeout}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("%w: the remote DSHKer peer endpoint is unavailable.", ErrPeerUnavailable)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	switch response.StatusCode {
	case http.StatusUnauthorized:
		return "", fmt.Errorf("%w: the remote DSHKer rejected peer authentication.", ErrPeerAuthentication)
	case http.StatusOK:
		return ClassifyRuntimeResponse(string(body))
	default:
		return "", fmt.Errorf("%w: the remote DSHKer could not provide a DSH session.", ErrPeerUnavailable)
	}
}

// temporaryDirectory creates the private directory the descriptor lands in.
func temporaryDirectory() (string, error) {
	directory, err := os.MkdirTemp("", "dshker-peer-")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		_ = os.RemoveAll(directory)
		return "", err
	}
	return directory, nil
}

// boundedBuffer keeps the first bytes of a diagnostic stream, which is what the
// classification needs and all it should ever hold.
type boundedBuffer struct {
	limit int
	data  strings.Builder
}

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	if buffer.data.Len() < buffer.limit {
		remaining := buffer.limit - buffer.data.Len()
		if len(data) > remaining {
			data = data[:remaining]
		}
		buffer.data.Write(data)
	}
	return len(data), nil
}

func (buffer *boundedBuffer) String() string { return buffer.data.String() }
