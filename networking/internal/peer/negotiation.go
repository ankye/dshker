package peer

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/pion/ice/v4"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// v1 uses complete, signed SDP with collected candidates; no unsigned trickle path.
func (transport *Transport) Offer(ctx context.Context) (protocol.Signal, error) {
	transport.mu.Lock()
	if transport.negotiated || transport.options.LocalDeviceID != transport.options.Scope.FromDeviceID {
		transport.mu.Unlock()
		return protocol.Signal{}, errors.New("p2p.signal_state_conflict")
	}
	transport.negotiated = true
	transport.mu.Unlock()
	offer, err := transport.pc.CreateOffer(nil)
	if err != nil {
		return protocol.Signal{}, err
	}
	return transport.gather(ctx, offer, "offer")
}

func (transport *Transport) AcceptOffer(ctx context.Context, signal protocol.Signal) (protocol.Signal, error) {
	transport.mu.Lock()
	if transport.negotiated || transport.options.LocalDeviceID != transport.options.Scope.ToDeviceID {
		transport.mu.Unlock()
		return protocol.Signal{}, errors.New("p2p.signal_state_conflict")
	}
	transport.negotiated = true
	transport.mu.Unlock()
	if err := transport.accept(signal, "offer", webrtc.SDPTypeOffer); err != nil {
		transport.fail(err)
		return protocol.Signal{}, err
	}
	answer, err := transport.pc.CreateAnswer(nil)
	if err != nil {
		return protocol.Signal{}, err
	}
	return transport.gather(ctx, answer, "answer")
}

func (transport *Transport) AcceptAnswer(signal protocol.Signal) error {
	if transport.options.LocalDeviceID != transport.options.Scope.FromDeviceID {
		return errors.New("p2p.signal_state_conflict")
	}
	err := transport.accept(signal, "answer", webrtc.SDPTypeAnswer)
	if err != nil {
		transport.fail(err)
	}
	return err
}

func (transport *Transport) gather(ctx context.Context, description webrtc.SessionDescription, kind string) (protocol.Signal, error) {
	complete := webrtc.GatheringCompletePromise(transport.pc)
	if err := transport.pc.SetLocalDescription(description); err != nil {
		return protocol.Signal{}, err
	}
	select {
	case <-ctx.Done():
		transport.fail(ctx.Err())
		return protocol.Signal{}, ctx.Err()
	case <-transport.ctx.Done():
		return protocol.Signal{}, errors.New("p2p.direct_closed")
	case <-complete:
	}
	local := transport.pc.LocalDescription()
	if local == nil {
		return protocol.Signal{}, errors.New("p2p.invalid_sdp")
	}
	if _, err := validateSDP(local.SDP); err != nil {
		return protocol.Signal{}, err
	}
	body, err := json.Marshal(protocol.SDP{SDP: local.SDP})
	if err != nil {
		return protocol.Signal{}, err
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.localSequence++
	scope := transport.options.Scope
	signal := protocol.Signal{Version: 1, Type: kind, MessageID: protocol.NewID(), AttemptID: scope.AttemptID, Generation: scope.Generation, FromDeviceID: transport.options.LocalDeviceID, ToDeviceID: transport.options.PeerDeviceID, PairID: scope.PairID, Sequence: transport.localSequence, Payload: base64.RawURLEncoding.EncodeToString(body), ExpiresAt: protocol.SignalExpiry(time.Now())}
	signal.Sign(transport.options.PrivateKey)
	return signal, nil
}

func (transport *Transport) accept(signal protocol.Signal, kind string, sdpType webrtc.SDPType) error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if signal.Type != kind || transport.remoteSequence != 0 {
		return errors.New("p2p.signal_state_conflict")
	}
	scope := protocol.SignalScope{AttemptID: transport.options.Scope.AttemptID, FromDeviceID: transport.options.PeerDeviceID, ToDeviceID: transport.options.LocalDeviceID, PairID: transport.options.Scope.PairID, Generation: transport.options.Scope.Generation, NextSequence: 1}
	if err := signal.Verify(transport.options.PeerKey, scope, time.Now()); err != nil {
		return err
	}
	body, err := base64.RawURLEncoding.DecodeString(signal.Payload)
	if err != nil {
		return errors.New("p2p.invalid_payload")
	}
	var payload protocol.SDP
	if err = protocol.Decode(body, &payload); err != nil {
		return err
	}
	fingerprint, err := validateSDP(payload.SDP)
	if err != nil {
		return err
	}
	transport.fingerprint = fingerprint
	if err = transport.pc.SetRemoteDescription(webrtc.SessionDescription{Type: sdpType, SDP: payload.SDP}); err != nil {
		return err
	}
	transport.remoteSequence = signal.Sequence
	return nil
}

func validateSDP(value string) (string, error) {
	var description sdp.SessionDescription
	if len(value) > 32*1024 || description.Unmarshal([]byte(value)) != nil || len(description.MediaDescriptions) != 1 {
		return "", errors.New("p2p.invalid_sdp")
	}
	media := description.MediaDescriptions[0]
	if media.MediaName.Media != "application" {
		return "", errors.New("p2p.invalid_sdp")
	}
	fingerprints := []string{}
	for _, attribute := range append(description.Attributes, media.Attributes...) {
		switch attribute.Key {
		case "fingerprint":
			fingerprints = append(fingerprints, attribute.Value)
		case "candidate":
			candidate, err := ice.UnmarshalCandidate(attribute.Value)
			// Every candidate must ride UDP. Relay candidates are legal: the
			// deployment server relays them only when no direct UDP path exists,
			// and ICE still prefers the direct host/reflexive pair first.
			if err != nil || !candidate.NetworkType().IsUDP() {
				return "", errors.New("p2p.direct_unavailable")
			}
		}
	}
	if len(fingerprints) != 1 {
		return "", errors.New("p2p.identity_mismatch")
	}
	parts := strings.Fields(fingerprints[0])
	if len(parts) != 2 || parts[0] != "sha-256" {
		return "", errors.New("p2p.identity_mismatch")
	}
	digest := strings.ToLower(strings.ReplaceAll(parts[1], ":", ""))
	if decoded, err := hex.DecodeString(digest); err != nil || len(decoded) != 32 {
		return "", errors.New("p2p.identity_mismatch")
	}
	return digest, nil
}
