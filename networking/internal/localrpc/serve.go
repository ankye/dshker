package localrpc

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// EndpointFileName is the record a headless core publishes for its own clients.
//
// It has the shape of the stdin bootstrap on purpose: the same endpoint and the
// same 32-byte secret, delivered by a private file instead of a parent process.
// A client that can read the file is this user, which is the whole claim.
const EndpointFileName = "core.json"

// NewSecret returns one 32-byte hex token.
func NewSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("p2p.helper_listen_failed")
	}
	return hex.EncodeToString(raw), nil
}

// WriteEndpointRecord publishes one endpoint record, readable only by this user.
func WriteEndpointRecord(path string, config Bootstrap) error {
	if filepath.Base(path) != EndpointFileName || !filepath.IsAbs(path) {
		return errors.New("p2p.invalid_socket")
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return errors.New("p2p.invalid_bootstrap")
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return errors.New("p2p.insecure_socket")
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return errors.New("p2p.insecure_socket")
	}
	return nil
}

// ReadEndpointRecord reads one published endpoint record.
func ReadEndpointRecord(path string) (Bootstrap, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Bootstrap{}, errors.New("p2p.helper_unavailable")
	}
	var config Bootstrap
	if protocol.DecodeExact(data, &config) != nil || config.Version != 1 {
		return Bootstrap{}, errors.New("p2p.invalid_bootstrap")
	}
	secret, err := hex.DecodeString(config.Secret)
	if err != nil || len(secret) != 32 || config.Socket == "" {
		return Bootstrap{}, errors.New("p2p.invalid_bootstrap")
	}
	return config, nil
}

// AcceptClient admits exactly one client that knows the endpoint secret.
func AcceptClient(ctx context.Context, listener net.Listener, secret string) (net.Conn, error) {
	type accepted struct {
		conn net.Conn
		err  error
	}
	results := make(chan accepted, 1)
	go func() {
		conn, err := listener.Accept()
		results <- accepted{conn: conn, err: err}
	}()
	var conn net.Conn
	select {
	case result := <-results:
		if result.err != nil {
			return nil, errors.New("p2p.helper_parent_unavailable")
		}
		conn = result.conn
	case <-ctx.Done():
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReaderSize(conn, protocol.MaxControlBytes+1)
	line, err := reader.ReadSlice('\n')
	var auth Authentication
	if err != nil || protocol.DecodeExact(line, &auth) != nil || auth.Version != 1 ||
		subtle.ConstantTimeCompare([]byte(auth.Secret), []byte(secret)) != 1 {
		conn.Close()
		return nil, errors.New("p2p.helper_authentication_failed")
	}
	auth.Secret = ""
	conn.SetReadDeadline(time.Time{})
	if err = json.NewEncoder(conn).Encode(struct {
		Version       int  `json:"version"`
		Authenticated bool `json:"authenticated"`
	}{1, true}); err != nil {
		conn.Close()
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	return &authenticatedConn{Conn: conn, reader: reader}, nil
}

// ServeEndpoint admits authenticated clients until the context ends.
//
// A headless core answers many short-lived clients — one per command — unlike the
// shell, which owns exactly one. Each admitted client gets its own peer, and the
// shared handler is what makes them equivalent.
func ServeEndpoint(ctx context.Context, listener net.Listener, secret string, handler Handler) error {
	return ServeEndpointWithPeers(ctx, listener, secret, func(*Peer) Handler { return handler }, nil)
}

// ServeEndpointWithPeers gives an authenticated long-lived desktop client a
// per-connection handler and a detach notification. Ordinary short-lived CLI
// clients still use ServeEndpoint and cannot become a callback owner by merely
// connecting; the endpoint handler must explicitly admit an attach request.
func ServeEndpointWithPeers(ctx context.Context, listener net.Listener, secret string, handlerFor func(*Peer) Handler, onDisconnect func(*Peer)) error {
	var mutex sync.Mutex
	peers := map[*Peer]bool{}
	defer func() {
		mutex.Lock()
		defer mutex.Unlock()
		for peer := range peers {
			peer.Close()
		}
	}()
	for {
		conn, err := AcceptClient(ctx, listener, secret)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// A client that failed authentication must not stop the daemon: the
			// next command is a new connection.
			if strings.Contains(err.Error(), "authentication_failed") {
				continue
			}
			return err
		}
		peer := NewWithPeer(ctx, conn, handlerFor)
		mutex.Lock()
		peers[peer] = true
		mutex.Unlock()
		go func() {
			<-peer.Done()
			if onDisconnect != nil {
				onDisconnect(peer)
			}
			mutex.Lock()
			delete(peers, peer)
			mutex.Unlock()
		}()
	}
}

// Connect dials a published endpoint and authenticates against it.
func Connect(ctx context.Context, socket string, secret string) (net.Conn, error) {
	conn, err := dialEndpoint(ctx, socket)
	if err != nil {
		return nil, errors.New("p2p.helper_unavailable")
	}
	reader := bufio.NewReaderSize(conn, protocol.MaxControlBytes+1)
	if err := json.NewEncoder(conn).Encode(Authentication{Version: 1, Secret: secret}); err != nil {
		conn.Close()
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	line, err := reader.ReadSlice('\n')
	var ack struct {
		Version       int  `json:"version"`
		Authenticated bool `json:"authenticated"`
	}
	if err != nil || protocol.DecodeExact(line, &ack) != nil || ack.Version != 1 || !ack.Authenticated {
		conn.Close()
		return nil, errors.New("p2p.helper_authentication_failed")
	}
	return &authenticatedConn{Conn: conn, reader: reader}, nil
}
