//go:build !windows

package localrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBootstrapAuthenticationAndPipelinedRequest(t *testing.T) {
	for _, valid := range []bool{true, false} {
		name := "wrong-secret"
		if valid {
			name = "authenticated-pipeline"
		}
		t.Run(name, func(t *testing.T) {
			// macOS Unix socket paths have a smaller bound than Go's default
			// per-test directory names. This directory contains no user data.
			root, err := os.MkdirTemp("", "drpc-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.Remove(filepath.Join(root, "peer.sock")); os.Remove(root) })
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			config := Bootstrap{Version: 1, Socket: filepath.Join(root, "peer.sock"), Secret: strings.Repeat("a", 64)}
			input, _ := json.Marshal(config)
			ready, output := io.Pipe()
			defer ready.Close()
			defer output.Close()
			type accepted struct {
				conn net.Conn
				err  error
			}
			result := make(chan accepted, 1)
			go func() {
				conn, err := AcceptMain(ctx, strings.NewReader(string(input)), output)
				result <- accepted{conn, err}
			}()
			line, err := bufio.NewReader(ready).ReadString('\n')
			if err != nil || line != "{\"version\":1,\"ready\":true}\n" {
				t.Fatalf("bootstrap readiness: %q %v", line, err)
			}
			client, err := net.DialTimeout("unix", config.Socket, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.SetDeadline(time.Now().Add(3 * time.Second))
			secret := config.Secret
			if !valid {
				secret = strings.Repeat("b", 64)
			}
			auth, _ := json.Marshal(Authentication{Version: 1, Secret: secret})
			request := `{"version":1,"id":1,"method":"echo","payload":{},"error":""}` + "\n"
			if _, err := client.Write(append(append(auth, '\n'), []byte(request)...)); err != nil {
				t.Fatal(err)
			}
			ack, ackErr := bufio.NewReader(client).ReadString('\n')
			var received accepted
			select {
			case received = <-result:
			case <-ctx.Done():
				t.Fatal("authentication did not finish")
			}
			if !valid {
				if received.conn != nil || received.err == nil || received.err.Error() != "p2p.helper_authentication_failed" || ackErr == nil {
					t.Fatalf("wrong secret accepted: %v %q %v", received.err, ack, ackErr)
				}
				return
			}
			if received.err != nil || ackErr != nil || ack != "{\"version\":1,\"authenticated\":true}\n" {
				t.Fatalf("authentication failed: %v %q %v", received.err, ack, ackErr)
			}
			defer received.conn.Close()
			received.conn.SetReadDeadline(time.Now().Add(time.Second))
			data := make([]byte, len(request))
			if _, err := io.ReadFull(received.conn, data); err != nil || string(data) != request {
				t.Fatalf("pipelined request lost: %q %v", data, err)
			}
		})
	}
}
