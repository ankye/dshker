//go:build windows

package localrpc

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

// testEndpoint returns a private endpoint the Windows listener accepts.
func testEndpoint(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return `\\.\pipe\dshker-peer-` + hex.EncodeToString(value)
}

func dialPrivate(endpoint string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return winio.DialPipeContext(ctx, endpoint)
}
