package localrpc

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

type Bootstrap struct {
	Version int    `json:"version"`
	Socket  string `json:"socket"`
	Secret  string `json:"secret"`
}
type Authentication struct {
	Version int    `json:"version"`
	Secret  string `json:"secret"`
}

// Preserve bytes read ahead with the authentication line. Authentication and
// RPC still share one ordered byte stream when the parent pipelines a request.
type authenticatedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (conn *authenticatedConn) Read(data []byte) (int, error) {
	return conn.reader.Read(data)
}

// AcceptMain consumes a one-shot stdin bootstrap, creates the private socket,
// and admits exactly one authenticated parent. It never prints credentials.
func AcceptMain(ctx context.Context, input io.Reader, output io.Writer) (net.Conn, error) {
	data, err := io.ReadAll(io.LimitReader(input, protocol.MaxControlBytes+1))
	var config Bootstrap
	if err != nil || protocol.Decode(data, &config) != nil || config.Version != 1 {
		return nil, errors.New("p2p.invalid_bootstrap")
	}
	secret, err := hex.DecodeString(config.Secret)
	if err != nil || len(secret) != 32 {
		return nil, errors.New("p2p.invalid_bootstrap")
	}
	listener, err := Listen(config.Socket)
	if err != nil {
		return nil, err
	}
	defer listener.Close()
	deadline, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	go func() { <-deadline.Done(); listener.Close() }()
	if _, err = io.WriteString(output, "{\"version\":1,\"ready\":true}\n"); err != nil {
		return nil, err
	}
	conn, err := listener.Accept()
	if err != nil {
		return nil, errors.New("p2p.helper_parent_unavailable")
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReaderSize(conn, protocol.MaxControlBytes+1)
	line, err := reader.ReadSlice('\n')
	var auth Authentication
	if err != nil || protocol.Decode(line, &auth) != nil || auth.Version != 1 || subtle.ConstantTimeCompare([]byte(auth.Secret), []byte(config.Secret)) != 1 {
		conn.Close()
		return nil, errors.New("p2p.helper_authentication_failed")
	}
	clear(secret)
	config.Secret = ""
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
