// Package peerbroker is the server half of the SSH route: the loopback endpoint a
// remote peer reaches through its forward, the bearer secret it authenticates
// with, and the descriptor file that tells it where to connect.
//
// It is the Go half of electron/main/remote/peer-broker.ts, ported rule for rule:
// loopback-only peers, exactly one route, a constant-time bearer comparison, the
// same strict response shape, and a descriptor written atomically with the same
// format and version.
package peerbroker

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/remoteroute"
)

// RuntimeRoute is the answered DSH session: the loopback URL the broker hands to
// an authenticated peer, or a refusal when this host has none to give.
type RuntimeRoute func(ctx context.Context) (string, error)

// Broker owns one published endpoint.
type Broker struct {
	DescriptorPath string
	Runtime        RuntimeRoute
	// Host is the loopback address to bind. It is always loopback: the endpoint
	// exists to be forwarded, never to be reachable from the network.
	Host string

	mutex      sync.Mutex
	listener   net.Listener
	server     *http.Server
	descriptor remoteroute.Descriptor

	// Now exists so a test can observe the descriptor lifetime.
	Now func() time.Time
}

// Start binds one loopback endpoint, publishes the descriptor, and begins
// answering. A broker that is already running is refused rather than doubled.
func (broker *Broker) Start() (remoteroute.Descriptor, error) {
	broker.mutex.Lock()
	defer broker.mutex.Unlock()
	if broker.listener != nil {
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker is already running.", remoteroute.ErrConnectionBusy)
	}
	host := broker.Host
	if host == "" {
		host = "127.0.0.1"
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker could not start.", remoteroute.ErrPeerUnavailable)
	}
	secret, err := newSecret()
	if err != nil {
		_ = listener.Close()
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker could not start.", remoteroute.ErrPeerUnavailable)
	}
	instance, err := newInstanceID()
	if err != nil {
		_ = listener.Close()
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker could not start.", remoteroute.ErrPeerUnavailable)
	}
	port, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker could not start.", remoteroute.ErrPeerUnavailable)
	}
	descriptor := remoteroute.Descriptor{
		Format:     remoteroute.DescriptorFormat,
		Version:    remoteroute.ProtocolVersion,
		InstanceID: instance,
		Port:       port.Port,
		Secret:     secret,
	}
	if err := writeDescriptor(broker.DescriptorPath, descriptor); err != nil {
		_ = listener.Close()
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker could not start.", remoteroute.ErrPeerUnavailable)
	}
	server := &http.Server{Handler: broker.handler(secret), ReadHeaderTimeout: 10 * time.Second}
	broker.listener = listener
	broker.server = server
	broker.descriptor = descriptor
	go func() { _ = server.Serve(listener) }()
	return descriptor, nil
}

// Shutdown stops the endpoint and removes the descriptor it published.
func (broker *Broker) Shutdown() error {
	broker.mutex.Lock()
	server := broker.server
	broker.listener = nil
	broker.server = nil
	broker.mutex.Unlock()
	if broker.DescriptorPath != "" {
		_ = os.Remove(broker.DescriptorPath)
	}
	if server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return server.Shutdown(ctx)
}

// Descriptor reports what is currently published.
func (broker *Broker) Descriptor() (remoteroute.Descriptor, bool) {
	broker.mutex.Lock()
	defer broker.mutex.Unlock()
	if broker.listener == nil {
		return remoteroute.Descriptor{}, false
	}
	return broker.descriptor, true
}

func (broker *Broker) handler(secret string) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !isLoopbackPeer(request.RemoteAddr) {
			sendJSON(writer, http.StatusForbidden, map[string]string{"error": "peer_not_loopback"})
			return
		}
		if request.Method != http.MethodPost || request.URL.Path != "/v1/runtime/connect" {
			sendJSON(writer, http.StatusNotFound, map[string]string{"error": "peer_route_not_found"})
			return
		}
		if !matchesBearer(request.Header.Get("Authorization"), secret) {
			sendJSON(writer, http.StatusUnauthorized, map[string]string{"error": "peer_authentication_failed"})
			return
		}
		if broker.Runtime == nil {
			sendJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "runtime_unavailable"})
			return
		}
		url, err := broker.Runtime(request.Context())
		if err != nil || url == "" {
			sendJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "runtime_unavailable"})
			return
		}
		sendJSON(writer, http.StatusOK, map[string]any{
			"version": remoteroute.ProtocolVersion,
			"url":     url,
		})
	})
}

// isLoopbackPeer accepts only a loopback remote address: the endpoint is reached
// through an SSH forward, so a peer from anywhere else is not one.
func isLoopbackPeer(remoteAddress string) bool {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	if host == "::1" {
		return true
	}
	parsed := net.ParseIP(strings.Trim(host, "[]"))
	return parsed != nil && parsed.IsLoopback()
}

func matchesBearer(header string, secret string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header[len(prefix):]), []byte(secret)) == 1
}

func sendJSON(writer http.ResponseWriter, status int, body any) {
	if status != http.StatusOK {
		// A refusal never echoes the secret or the request.
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(append(encoded, '\n'))
}

func newSecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func newInstanceID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	values := []byte(hex.EncodeToString(value))
	values[12] = '4'
	values[16] = "89ab"[values[16]%4]
	return string(values[0:8]) + "-" + string(values[8:12]) + "-" + string(values[12:16]) + "-" + string(values[16:20]) + "-" + string(values[20:32]), nil
}

// writeDescriptor publishes the descriptor atomically, readable only by this user.
func writeDescriptor(path string, descriptor remoteroute.Descriptor) error {
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("the descriptor path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	encoded, err := json.Marshal(descriptor)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}
