package localrpc

import (
	"bufio"
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestConnectAuthenticationCancellationClosesUnresponsivePeer(t *testing.T) {
	for _, partial := range []bool{false, true} {
		name := "no-ack"
		if partial {
			name = "partial-ack"
		}
		t.Run(name, func(t *testing.T) {
			endpoint := endpointIn(t, stateDirectory(t))
			listener, err := Listen(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			inAuthentication := make(chan struct{})
			peerEnded := make(chan error, 1)
			go func() {
				connection, err := listener.Accept()
				if err != nil {
					peerEnded <- err
					return
				}
				defer connection.Close()
				reader := bufio.NewReader(connection)
				if _, err := reader.ReadString('\n'); err != nil {
					peerEnded <- err
					return
				}
				if partial {
					if _, err := io.WriteString(connection, `{"version":1,"authenticated":`); err != nil {
						peerEnded <- err
						return
					}
				}
				close(inAuthentication)
				_, err = reader.ReadByte()
				peerEnded <- err
			}()
			result := make(chan error, 1)
			go func() {
				connection, err := Connect(ctx, endpoint, "test-authentication-token")
				if connection != nil {
					connection.Close()
				}
				result <- err
			}()
			select {
			case <-inAuthentication:
			case <-time.After(5 * time.Second):
				t.Fatal("test never reached the accepted authentication phase")
			}
			cancel()
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("canceled incomplete authentication returned a successful connection")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("authentication ignored context cancellation after accept")
			}
			select {
			case err := <-peerEnded:
				if err == nil {
					t.Fatal("canceled authentication did not close its underlying connection")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("canceled authentication leaked its accepted connection")
			}
		})
	}
}

func TestConnectAuthenticatedConnectionOutlivesStartupContext(t *testing.T) {
	endpoint := endpointIn(t, stateDirectory(t))
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		if _, err := bufio.NewReader(connection).ReadString('\n'); err != nil {
			connection.Close()
			return
		}
		if _, err := io.WriteString(connection, "{\"version\":1,\"authenticated\":true}\n"); err != nil {
			connection.Close()
			return
		}
		accepted <- connection
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, err := Connect(ctx, endpoint, "test-authentication-token")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	peer := <-accepted
	defer peer.Close()
	cancel()
	if err := connection.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	written := make(chan error, 1)
	go func() { _, err := connection.Write([]byte{1}); written <- err }()
	if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var value [1]byte
	if _, err := io.ReadFull(peer, value[:]); err != nil || value[0] != 1 {
		t.Fatal("successful authentication retained startup cancellation ownership")
	}
	if err := <-written; err != nil {
		t.Fatalf("persistent authenticated write failed after startup cancellation: %v", err)
	}
}
