package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type TransportOptions struct {
	UserID        string
	NetworkID     string
	STUNAddress   string
	LocalDeviceID string
	PeerDeviceID  string
	PrivateKey    ed25519.PrivateKey
	PeerKey       ed25519.PublicKey
	ServiceKey    ed25519.PublicKey
	Scope         protocol.SignalScope
	Revision      uint64
	Lease         protocol.Lease
}

type DirectPath struct {
	LocalType  string `json:"localType"`
	RemoteType string `json:"remoteType"`
	Protocol   string `json:"protocol"`
}

// Transport exposes only authenticated direct bytes. The caller still owns DSH readiness.
type Transport struct {
	options        TransportOptions
	pc             *webrtc.PeerConnection
	channel        *webrtc.DataChannel
	ctx            context.Context
	cancel         context.CancelFunc
	closed         chan struct{}
	ready          chan struct{}
	messages       chan []byte
	errors         chan error
	mu             sync.Mutex
	sendMu         sync.Mutex
	readyOnce      sync.Once
	fingerprint    string
	lease          protocol.Lease
	leaseChanged   chan struct{}
	remoteSequence uint64
	localSequence  uint64
	negotiated     bool
}

func NewTransport(parent context.Context, options TransportOptions) (*Transport, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	engine := webrtc.SettingEngine{}
	engine.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	engine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	engine.SetICETimeouts(5*time.Second, 25*time.Second, 2*time.Second)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(engine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:" + options.STUNAddress}}}})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	transport := &Transport{options: options, pc: pc, ctx: ctx, cancel: cancel, closed: make(chan struct{}), ready: make(chan struct{}), messages: make(chan []byte, 64), errors: make(chan error, 1), lease: options.Lease, leaseChanged: make(chan struct{}, 1)}
	ordered, negotiated, id, subprotocol := true, true, uint16(0), "dshker.direct.v1"
	channel, err := pc.CreateDataChannel(subprotocol, &webrtc.DataChannelInit{Ordered: &ordered, Negotiated: &negotiated, ID: &id, Protocol: &subprotocol})
	if err != nil {
		cancel()
		pc.Close()
		return nil, err
	}
	transport.channel = channel
	transport.bindEvents()
	go func() { <-ctx.Done(); pc.Close(); close(transport.closed) }()
	go transport.enforceLease()
	return transport, nil
}

func validateOptions(options TransportOptions) error {
	host, port, err := net.SplitHostPort(options.STUNAddress)
	if err != nil || host == "" || strings.ContainsAny(host, "/?#@") {
		return errors.New("p2p.explicit_stun_required")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return errors.New("p2p.invalid_stun_endpoint")
	}
	if len(options.PrivateKey) != ed25519.PrivateKeySize || len(options.PeerKey) != ed25519.PublicKeySize || options.PrivateKey.Public().(ed25519.PublicKey).Equal(options.PeerKey) {
		return errors.New("p2p.invalid_device_key")
	}
	if options.LocalDeviceID == options.PeerDeviceID || !protocol.ValidID(options.LocalDeviceID) || !protocol.ValidID(options.PeerDeviceID) {
		return errors.New("p2p.identity_mismatch")
	}
	if !((options.LocalDeviceID == options.Scope.FromDeviceID && options.PeerDeviceID == options.Scope.ToDeviceID) || (options.PeerDeviceID == options.Scope.FromDeviceID && options.LocalDeviceID == options.Scope.ToDeviceID)) {
		return errors.New("p2p.lease_scope_mismatch")
	}
	return options.Lease.Verify(options.ServiceKey, options.Scope, options.UserID, options.NetworkID, options.Revision, time.Now())
}

func (transport *Transport) bindEvents() {
	transport.pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.Close()
		transport.fail(errors.New("p2p.unexpected_data_channel"))
	})
	transport.pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateDisconnected {
			transport.fail(errors.New("p2p.direct_unavailable"))
		}
	})
	transport.channel.OnOpen(func() {
		if _, err := transport.Path(); err != nil {
			transport.fail(err)
			return
		}
		transport.readyOnce.Do(func() { close(transport.ready) })
	})
	transport.channel.OnClose(func() { transport.fail(errors.New("p2p.direct_closed")) })
	transport.channel.OnError(transport.fail)
	transport.channel.OnMessage(func(message webrtc.DataChannelMessage) {
		select {
		case <-transport.ready:
		default:
			transport.fail(errors.New("p2p.identity_not_verified"))
			return
		}
		if message.IsString || len(message.Data) == 0 || len(message.Data) > protocol.MaxControlBytes {
			transport.fail(errors.New("p2p.protocol_limit"))
			return
		}
		select {
		case transport.messages <- append([]byte(nil), message.Data...):
		default:
			transport.fail(errors.New("p2p.receive_limit"))
		}
	})
}

func (transport *Transport) WaitReady(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-transport.ctx.Done():
		return errors.New("p2p.direct_unavailable")
	case <-transport.ready:
		_, err := transport.Path()
		return err
	}
}

func (transport *Transport) Messages() <-chan []byte { return transport.messages }
func (transport *Transport) Errors() <-chan error    { return transport.errors }
func (transport *Transport) Done() <-chan struct{}   { return transport.ctx.Done() }

func (transport *Transport) Send(data []byte) error {
	transport.sendMu.Lock()
	defer transport.sendMu.Unlock()
	select {
	case <-transport.ready:
	default:
		return errors.New("p2p.identity_not_verified")
	}
	select {
	case <-transport.ctx.Done():
		return errors.New("p2p.direct_closed")
	default:
	}
	transport.mu.Lock()
	expires := transport.lease.ExpiresAt
	transport.mu.Unlock()
	if expires <= time.Now().Unix() {
		transport.fail(errors.New("p2p.lease_expired"))
		return errors.New("p2p.lease_expired")
	}
	if len(data) == 0 || len(data) > protocol.MaxControlBytes || transport.channel.BufferedAmount()+uint64(len(data)) > protocol.MaxQueueBytes {
		return errors.New("p2p.send_limit")
	}
	return transport.channel.Send(data)
}

func (transport *Transport) Path() (DirectPath, error) {
	transport.mu.Lock()
	fingerprint := transport.fingerprint
	transport.mu.Unlock()
	dtls := transport.pc.SCTP().Transport()
	digest := sha256.Sum256(dtls.GetRemoteCertificate())
	if fingerprint == "" || hex.EncodeToString(digest[:]) != fingerprint {
		return DirectPath{}, errors.New("p2p.identity_mismatch")
	}
	pair, err := dtls.ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil || pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay || pair.Local.Protocol != webrtc.ICEProtocolUDP || pair.Remote.Protocol != webrtc.ICEProtocolUDP {
		return DirectPath{}, errors.New("p2p.direct_unavailable")
	}
	return DirectPath{pair.Local.Typ.String(), pair.Remote.Typ.String(), "udp"}, nil
}

func (transport *Transport) UpdateLease(lease protocol.Lease) error {
	if err := lease.Verify(transport.options.ServiceKey, transport.options.Scope, transport.options.UserID, transport.options.NetworkID, transport.options.Revision, time.Now()); err != nil {
		return err
	}
	transport.mu.Lock()
	if transport.lease.ExpiresAt <= time.Now().Unix() || lease.ExpiresAt < transport.lease.ExpiresAt {
		transport.mu.Unlock()
		return errors.New("p2p.lease_expired")
	}
	transport.lease = lease
	transport.mu.Unlock()
	select {
	case transport.leaseChanged <- struct{}{}:
	default:
	}
	return nil
}

func (transport *Transport) enforceLease() {
	for {
		transport.mu.Lock()
		expiry := transport.lease.ExpiresAt
		transport.mu.Unlock()
		timer := time.NewTimer(time.Until(time.Unix(expiry, 0)))
		select {
		case <-transport.ctx.Done():
			timer.Stop()
			return
		case <-transport.leaseChanged:
			timer.Stop()
		case <-timer.C:
			transport.mu.Lock()
			expired := transport.lease.ExpiresAt <= time.Now().Unix()
			transport.mu.Unlock()
			if expired {
				transport.fail(errors.New("p2p.lease_expired"))
				return
			}
		}
	}
}

func (transport *Transport) fail(err error) {
	select {
	case transport.errors <- err:
	default:
	}
	transport.cancel()
}

func (transport *Transport) Close() error { transport.cancel(); <-transport.closed; return nil }
