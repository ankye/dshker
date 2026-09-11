package peer

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/pion/stun/v3"
	"github.com/pion/webrtc/v4"
)

func optionsPair(t *testing.T) (TransportOptions, TransportOptions) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	firstPublic, firstKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secondPublic, secondKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	scope := protocol.SignalScope{AttemptID: protocol.NewID(), FromDeviceID: protocol.NewID(), ToDeviceID: protocol.NewID(), PairID: protocol.NewID(), Generation: 1, NextSequence: 1}
	lease := protocol.Lease{Version: 1, ServiceID: protocol.KeyID(public), PairID: scope.PairID, AttemptID: scope.AttemptID, FromDeviceID: scope.FromDeviceID, ToDeviceID: scope.ToDeviceID, Generation: 1, Revision: 1, ExpiresAt: time.Now().Add(time.Minute).Unix(), Permission: "dsh-session"}
	lease.UserID, lease.NetworkID = protocol.NewID(), protocol.NewID()
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, lease.SigningBytes()))
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- serveSTUNFixture(ctx, listener) }()
	t.Cleanup(func() {
		cancel()
		listener.Close()
		if err := <-finished; err != nil {
			t.Error(err)
		}
	})
	first := TransportOptions{STUNAddress: listener.LocalAddr().String(), LocalDeviceID: scope.FromDeviceID, PeerDeviceID: scope.ToDeviceID, PrivateKey: firstKey, PeerKey: secondPublic, ServiceKey: public, Scope: scope, Revision: 1, Lease: lease}
	first.UserID, first.NetworkID = lease.UserID, lease.NetworkID
	second := first
	second.LocalDeviceID, second.PeerDeviceID, second.PrivateKey, second.PeerKey = scope.ToDeviceID, scope.FromDeviceID, secondKey, firstPublic
	return first, second
}

// 本机传输单测的真实 UDP 协议端点，不替代独立服务器或跨物理机验收。
func serveSTUNFixture(ctx context.Context, listener *net.UDPConn) error {
	buffer := make([]byte, 1024)
	for {
		n, address, err := listener.ReadFromUDP(buffer)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		request := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
		if request.Decode() != nil || request.Type != stun.BindingRequest {
			continue
		}
		response, err := stun.Build(stun.NewTransactionIDSetter(request.TransactionID), stun.BindingSuccess, &stun.XORMappedAddress{IP: address.IP, Port: address.Port})
		if err != nil {
			return err
		}
		if _, err = listener.WriteToUDP(response.Raw, address); err != nil {
			return err
		}
	}
}

func TestRealTwoPeerDirectDTLSAndDataChannel(t *testing.T) {
	firstOptions, secondOptions := optionsPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
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
	if first.Send([]byte("before identity")) == nil {
		t.Fatal("sent before authenticated channel")
	}
	offer, err := first.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := second.AcceptOffer(ctx, offer)
	if err != nil {
		t.Fatal(err)
	}
	if err = first.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, transport := range []*Transport{first, second} {
		if err = transport.WaitReady(ctx); err != nil {
			t.Fatal(err)
		}
		path, err := transport.Path()
		if err != nil || path.Protocol != "udp" || path.LocalType == "relay" || path.RemoteType == "relay" {
			t.Fatal("non-direct candidate", path, err)
		}
		t.Logf("actual direct candidate pair: %+v", path)
	}
	content := []byte("DSHKer authenticated direct bytes\x00\xff")
	if err = first.Send(content); err != nil {
		t.Fatal(err)
	}
	select {
	case received := <-second.Messages():
		if !bytes.Equal(received, content) {
			t.Fatal("direct payload differs")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err = second.Send(content); err != nil {
		t.Fatal(err)
	}
	select {
	case received := <-first.Messages():
		if !bytes.Equal(received, content) {
			t.Fatal("reverse payload differs")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if first.Send(make([]byte, protocol.MaxControlBytes+1)) == nil {
		t.Fatal("accepted oversized payload")
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	if first.Send(content) == nil {
		t.Fatal("sent after close")
	}
}

func TestTamperedSDPRejectedBeforeChannel(t *testing.T) {
	firstOptions, secondOptions := optionsPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
	body, err := base64.RawURLEncoding.DecodeString(offer.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var payload protocol.SDP
	if err = protocol.Decode(body, &payload); err != nil {
		t.Fatal(err)
	}
	payload.SDP = strings.Replace(payload.SDP, "a=fingerprint:sha-256 ", "a=fingerprint:sha-256 FF:", 1)
	body, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	offer.Payload = base64.RawURLEncoding.EncodeToString(body)
	if _, err = second.AcceptOffer(ctx, offer); err == nil {
		t.Fatal("tampered fingerprint accepted")
	}
	if second.Send([]byte("secret")) == nil {
		t.Fatal("released data after identity mismatch")
	}
}

func TestIceServersForDirectOnly(t *testing.T) {
	servers := iceServersFor(TransportOptions{STUNAddress: "127.0.0.1:3478"})
	if len(servers) != 1 {
		t.Fatalf("expected direct-only ICE servers, got %d", len(servers))
	}
	if servers[0].URLs[0] != "stun:127.0.0.1:3478" {
		t.Fatalf("unexpected STUN url %q", servers[0].URLs[0])
	}
	if servers[0].Credential != nil {
		t.Fatal("stun server carries a credential")
	}
}

func TestIceServersForWithRelayFallback(t *testing.T) {
	servers := iceServersFor(TransportOptions{
		STUNAddress:    "127.0.0.1:3478",
		TurnURL:        "turn:127.0.0.1:3478",
		TurnUsername:   "1750000000:device-1",
		TurnCredential: "cGFzcw==",
	})
	if len(servers) != 2 {
		t.Fatalf("expected direct+relay ICE servers, got %d", len(servers))
	}
	relay := servers[1]
	if relay.URLs[0] != "turn:127.0.0.1:3478" || relay.Username != "1750000000:device-1" || relay.Credential != "cGFzcw==" || relay.CredentialType != webrtc.ICECredentialTypePassword {
		t.Fatalf("unexpected relay server: %+v", relay)
	}
}

func TestTransportRejectsMissingAuthorityAndTURN(t *testing.T) {
	options, _ := optionsPair(t)
	for name, change := range map[string]func(*TransportOptions){
		"missing server": func(o *TransportOptions) { o.STUNAddress = "" },
		"TURN":           func(o *TransportOptions) { o.STUNAddress = "turn:example.com:3478" },
		"no lease":       func(o *TransportOptions) { o.Lease = protocol.Lease{} },
		"other peer":     func(o *TransportOptions) { o.PeerDeviceID = protocol.NewID() },
		"revision":       func(o *TransportOptions) { o.Revision++ },
		"expired":        func(o *TransportOptions) { o.Lease.ExpiresAt = time.Now().Unix() },
	} {
		t.Run(name, func(t *testing.T) {
			copy := options
			change(&copy)
			if transport, err := NewTransport(context.Background(), copy); err == nil {
				transport.Close()
				t.Fatal("invalid authority accepted")
			}
		})
	}
}
