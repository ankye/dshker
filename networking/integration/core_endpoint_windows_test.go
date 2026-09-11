//go:build windows

package integration

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

// coreEndpoint returns a private endpoint the core listener accepts.
func coreEndpoint(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return `\\.\pipe\dshker-peer-` + hex.EncodeToString(value)
}

func dialCore(endpoint string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return winio.DialPipeContext(ctx, endpoint)
}
