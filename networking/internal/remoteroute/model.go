// Package remoteroute owns the SSH route to another computer's DSHKer peer:
// OpenSSH resolution, the descriptor transfer, the two port forwards, the
// loopback broker call, and the loopback-only validation of the remote DSH URL.
//
// It is the Go half of electron/main/remote/{openssh,peer-broker}.ts. The rules
// are ported rather than reinterpreted: the same argument order, the same strict
// descriptor and response shapes, the same failure classifications, and the same
// refusal to accept a non-loopback address.
package remoteroute

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

// The persisted descriptor one remote peer publishes in its home directory, and
// the protocol version both sides speak.
const (
	DescriptorFormat       = "dsh-launcher.remote-peer"
	ProtocolVersion        = 1
	DescriptorRelativePath = ".dshlauncher/remote-peer.json"
	DescriptorFileName     = "remote-peer.json"
)

// Refusal codes the shell already maps. They cross the private channel
// unchanged, which is why the protocol declares the remote family.
var (
	ErrUnavailable          = errors.New("remote.ssh_unavailable")
	ErrAuthenticationFailed = errors.New("remote.ssh_authentication_failed")
	ErrPeerUnavailable      = errors.New("remote.peer_unavailable")
	ErrPeerAuthentication   = errors.New("remote.peer_authentication_failed")
	ErrPeerProtocolInvalid  = errors.New("remote.peer_protocol_invalid")
	ErrTunnelFailed         = errors.New("remote.tunnel_failed")
	ErrConnectionBusy       = errors.New("remote.connection_busy")
	ErrInputInvalid         = errors.New("remote.input_invalid")
)

// Computer is the remote account the route connects to.
type Computer struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}

// AssertComputer refuses anything that could not be one SSH destination.
func AssertComputer(computer Computer) error {
	if computer.Host == "" || computer.User == "" ||
		strings.ContainsAny(computer.Host, " \t@:/") ||
		strings.ContainsAny(computer.User, " \t@:/") ||
		computer.Port < 1 || computer.Port > 65535 {
		return fmt.Errorf("%w: the remote computer is invalid.", ErrInputInvalid)
	}
	return nil
}

// Executables is the OpenSSH pair one platform uses.
type Executables struct {
	SSH string `json:"ssh"`
	SCP string `json:"scp"`
}

// ResolveExecutables returns the fixed OpenSSH clients for one platform. macOS
// and Linux use the system paths; Windows resolves the PATH entry, because the
// system location is not guaranteed and the client is a native executable.
func ResolveExecutables(platform string) Executables {
	if platform == "windows" {
		return Executables{SSH: "ssh.exe", SCP: "scp.exe"}
	}
	return Executables{SSH: "/usr/bin/ssh", SCP: "/usr/bin/scp"}
}

// BuildScpArguments renders the exact file transfer of one descriptor.
func BuildScpArguments(computer Computer, destinationPath string) []string {
	return []string{
		"-q",
		"-B",
		"-o",
		"StrictHostKeyChecking=yes",
		"-P",
		strconv.Itoa(computer.Port),
		computer.User + "@" + computer.Host + ":" + DescriptorRelativePath,
		filepath.Clean(destinationPath),
	}
}

// BuildSshForwardArguments renders one non-interactive loopback forward. Batch
// mode and exit-on-forward-failure are what keep a refused tunnel a failure
// rather than an invisible password prompt or a silently unforwarded port.
func BuildSshForwardArguments(computer Computer, localPort int, remotePort int) []string {
	return []string{
		"-N",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-p",
		strconv.Itoa(computer.Port),
		"-L",
		"127.0.0.1:" + strconv.Itoa(localPort) + ":127.0.0.1:" + strconv.Itoa(remotePort),
		computer.User + "@" + computer.Host,
	}
}

// Descriptor is what one remote peer publishes for this route.
type Descriptor struct {
	Format     string `json:"format"`
	Version    int    `json:"version"`
	InstanceID string `json:"instanceId"`
	Port       int    `json:"port"`
	Secret     string `json:"secret"`
}

// ParseDescriptor strictly parses the descriptor an SCP transfer delivered. A
// missing, extra or mistyped field is refused: this document names the port and
// bearer secret the route will trust, so guessing any of it would be worse than
// failing.
func ParseDescriptor(data []byte) (Descriptor, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return Descriptor{}, fmt.Errorf("%w: the remote peer descriptor is not an object.", ErrPeerProtocolInvalid)
	}
	expected := []string{"format", "version", "instanceId", "port", "secret"}
	if len(fields) != len(expected) {
		return Descriptor{}, fmt.Errorf("%w: the remote peer descriptor fields are invalid.", ErrPeerProtocolInvalid)
	}
	for _, name := range expected {
		if _, ok := fields[name]; !ok {
			return Descriptor{}, fmt.Errorf("%w: the remote peer descriptor fields are invalid.", ErrPeerProtocolInvalid)
		}
	}
	var descriptor Descriptor
	if json.Unmarshal(data, &descriptor) != nil {
		return Descriptor{}, fmt.Errorf("%w: the remote peer descriptor is invalid.", ErrPeerProtocolInvalid)
	}
	if descriptor.Format != DescriptorFormat || descriptor.Version != ProtocolVersion ||
		descriptor.InstanceID == "" || descriptor.Secret == "" ||
		descriptor.Port < 1 || descriptor.Port > 65535 {
		return Descriptor{}, fmt.Errorf("%w: the remote peer descriptor is invalid.", ErrPeerProtocolInvalid)
	}
	return descriptor, nil
}

// ParseRuntimeURL reads the DSH address a remote peer returned, accepting only an
// explicit loopback http(s) origin. A non-loopback address is refused rather than
// forwarded: the tunnel exists so the session never leaves the machine, and an
// address outside it would mean the peer answered with something else entirely.
func ParseRuntimeURL(value string) (string, int, error) {
	parsed, err := url.Parse(value)
	if err != nil {
		return "", 0, fmt.Errorf("%w: the remote DSH URL is malformed.", ErrPeerProtocolInvalid)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || !isLoopbackHost(parsed.Hostname()) || parsed.Port() == "" {
		return "", 0, fmt.Errorf("%w: the remote DSH URL is not an explicit loopback address.", ErrPeerProtocolInvalid)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("%w: the remote DSH URL port is invalid.", ErrPeerProtocolInvalid)
	}
	return parsed.String(), port, nil
}

// MapLoopback rewrites one accepted URL onto the local forward that carries it.
func MapLoopback(value string, localPort int) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("%w: the remote DSH URL is malformed.", ErrPeerProtocolInvalid)
	}
	parsed.Host = "127.0.0.1:" + strconv.Itoa(localPort)
	return parsed.String(), nil
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// ClassifySSHFailure reads one OpenSSH diagnostic and reports the refusal it
// warrants, so an authentication problem is never reported as a missing peer.
func ClassifySSHFailure(stderr string) error {
	lowered := strings.ToLower(stderr)
	for _, marker := range []string{"permission denied", "authentication failed", "host key verification failed"} {
		if strings.Contains(lowered, marker) {
			return fmt.Errorf("%w: SSH authentication or host verification failed.", ErrAuthenticationFailed)
		}
	}
	return nil
}

// ClassifyRuntimeResponse reads one broker answer body and reports the session
// URL it carries, requiring exactly the two declared fields.
func ClassifyRuntimeResponse(body string) (string, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(body), &fields) != nil || fields == nil || len(fields) != 2 {
		return "", fmt.Errorf("%w: the remote DSHKer response is invalid.", ErrPeerProtocolInvalid)
	}
	version, hasVersion := fields["version"]
	urlField, hasURL := fields["url"]
	if !hasVersion || !hasURL {
		return "", fmt.Errorf("%w: the remote DSHKer response is invalid.", ErrPeerProtocolInvalid)
	}
	var reported int
	var value string
	if json.Unmarshal(version, &reported) != nil || reported != ProtocolVersion || json.Unmarshal(urlField, &value) != nil {
		return "", fmt.Errorf("%w: the remote DSHKer response is invalid.", ErrPeerProtocolInvalid)
	}
	return value, nil
}
