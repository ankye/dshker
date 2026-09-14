package peer

// Task 5.2: the relay carries only end-to-end encrypted packets. This drives a
// real session whose only possible path is a local TURN server, records every
// datagram that server receives, and proves the application's own bytes never
// appear in any of them.
import (
	"bytes"
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

// recordingConn keeps every datagram a relay receives, which is exactly what a
// hostile relay operator would be able to read.
type recordingConn struct {
	net.PacketConn

	mutex     sync.Mutex
	datagrams [][]byte
}

func (conn *recordingConn) ReadFrom(buffer []byte) (int, net.Addr, error) {
	read, address, err := conn.PacketConn.ReadFrom(buffer)
	if read > 0 {
		conn.mutex.Lock()
		conn.datagrams = append(conn.datagrams, append([]byte(nil), buffer[:read]...))
		conn.mutex.Unlock()
	}
	return read, address, err
}

func (conn *recordingConn) recorded() [][]byte {
	conn.mutex.Lock()
	defer conn.mutex.Unlock()
	return append([][]byte(nil), conn.datagrams...)
}

// relayFixture starts one TURN server on a recording socket and returns its
// address, the shared credential, and the recorder.
func relayFixture(t *testing.T) (string, string, string, *recordingConn) {
	t.Helper()
	socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	recorder := &recordingConn{PacketConn: socket}
	const (
		username = "1750000000:device-1"
		password = "pass"
		realm    = "dshker.test"
	)
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(attributes *turn.RequestAttributes) (string, []byte, bool) {
			if attributes.Username != username || attributes.Realm != realm {
				return "", nil, false
			}
			return username, turn.GenerateAuthKey(username, realm, password), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: recorder,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP("127.0.0.1"),
				Address:      "127.0.0.1",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := server.Close(); err != nil {
			t.Error(err)
		}
	})
	return recorder.LocalAddr().String(), username, password, recorder
}

// TestRelayCarriesOnlyCiphertext completes a session whose only path is the
// relay, delivers a known marker over it, and then asserts that the relay saw
// traffic but never that marker.
func TestRelayCarriesOnlyCiphertext(t *testing.T) {
	address, username, password, recorder := relayFixture(t)
	firstOptions, secondOptions := optionsPair(t)
	for _, options := range []*TransportOptions{&firstOptions, &secondOptions} {
		options.STUNAddress = address
		options.TurnURL = "turn:" + address + "?transport=udp"
		options.TurnUsername = username
		options.TurnCredential = password
		options.RelayOnly = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	first, err := NewTransport(ctx, firstOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := NewTransport(ctx, secondOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	offer, err := first.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := second.AcceptOffer(ctx, offer)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	// A relay-only session can only become ready through the relay; a failure here
	// would mean the test proved nothing.
	for _, transport := range []*Transport{first, second} {
		if err := transport.WaitReady(ctx); err != nil {
			t.Fatalf("the relayed session never became ready: %v", err)
		}
		path, err := transport.Path()
		if err != nil || path.Protocol != "udp" {
			t.Fatalf("relayed path = %+v, %v", path, err)
		}
		// Both ends must have selected a relayed candidate: a host candidate would
		// mean the session escaped the relay and the recording proves nothing.
		if path.LocalType != "relay" || path.RemoteType != "relay" {
			t.Fatalf("selected pair is not relayed: %+v", path)
		}
	}
	marker := []byte("DSHKER-RELAY-PLAINTEXT-MARKER-0123456789")
	if err := first.Send(marker); err != nil {
		t.Fatalf("send: %v", err)
	}
	select {
	case received := <-second.Messages():
		if !bytes.Equal(received, marker) {
			t.Fatalf("received %q", received)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the marker never arrived")
	}
	// The relay definitely carried traffic...
	recorded := recorder.recorded()
	if len(recorded) == 0 {
		t.Fatal("the relay never saw a datagram, so the path was not relayed")
	}
	// ...and none of it was the application's plaintext.
	for index, datagram := range recorded {
		if bytes.Contains(datagram, marker) {
			t.Fatalf("datagram %d carried the plaintext marker", index)
		}
	}
}
