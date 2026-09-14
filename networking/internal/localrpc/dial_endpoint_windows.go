//go:build windows

package localrpc

import (
	"context"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

// dialEndpoint connects to one private endpoint. Windows addresses the named
// pipe directly, because the endpoint is not a path.
func dialEndpoint(ctx context.Context, socket string) (net.Conn, error) {
	budget, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return winio.DialPipeContext(budget, socket)
}
