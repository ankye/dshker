//go:build !windows

package localrpc

import (
	"context"
	"net"
	"time"
)

// dialEndpoint connects to one private endpoint. Unix uses the socket path the
// listener created; Windows addresses the named pipe.
func dialEndpoint(ctx context.Context, socket string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: 10 * time.Second}
	return dialer.DialContext(ctx, "unix", socket)
}
