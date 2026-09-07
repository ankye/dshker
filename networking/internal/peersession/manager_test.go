package peersession

import (
	"bytes"
	"strings"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

func pinFixture() (*Manager, controlplane.PairIdentity) {
	local := controlplane.PairDeviceIdentity{DeviceID: strings.Repeat("a", 32), UserID: strings.Repeat("b", 32), PublicKey: bytes.Repeat([]byte{1}, 32)}
	remote := controlplane.PairDeviceIdentity{DeviceID: strings.Repeat("c", 32), UserID: local.UserID, PublicKey: bytes.Repeat([]byte{2}, 32)}
	pin := controlplane.PairIdentity{Pair: controlplane.Pair{PairID: strings.Repeat("d", 32), NetworkID: strings.Repeat("e", 32), Initiator: local.DeviceID, Target: remote.DeviceID, State: "active", Revision: 2}, Initiator: local, Target: remote}
	manager := &Manager{config: Config{Device: controlplane.Device{DeviceID: local.DeviceID, UserID: local.UserID, PublicKey: append([]byte(nil), local.PublicKey...)}}, pins: make(map[string]controlplane.PairIdentity)}
	return manager, pin
}

func TestPinRejectsIdentityReplacement(t *testing.T) {
	for name, mutate := range map[string]func(*controlplane.PairIdentity){
		"network":  func(p *controlplane.PairIdentity) { p.Pair.NetworkID = strings.Repeat("f", 32) },
		"revision": func(p *controlplane.PairIdentity) { p.Pair.Revision = 1 },
		"user": func(p *controlplane.PairIdentity) {
			p.Initiator.UserID = strings.Repeat("f", 32)
			p.Target.UserID = p.Initiator.UserID
		},
		"key":             func(p *controlplane.PairIdentity) { p.Target.PublicKey = bytes.Repeat([]byte{3}, 32) },
		"binding":         func(p *controlplane.PairIdentity) { p.Pair.Target = p.Initiator.DeviceID },
		"invalid-network": func(p *controlplane.PairIdentity) { p.Pair.NetworkID = "" },
		"revoked":         func(p *controlplane.PairIdentity) { p.Pair.State = "revoked" },
	} {
		t.Run(name, func(t *testing.T) {
			manager, pin := pinFixture()
			if err := manager.Pin(pin); err != nil {
				t.Fatal(err)
			}
			mutate(&pin)
			if err := manager.Pin(pin); err == nil || err.Error() != "p2p.identity_mismatch" {
				t.Fatalf("replacement accepted: %v", err)
			}
			stored := manager.pins[pin.Pair.PairID]
			_, expected := pinFixture()
			if stored.Pair != expected.Pair || !bytes.Equal(stored.Target.PublicKey, expected.Target.PublicKey) || stored.Initiator.UserID != expected.Initiator.UserID {
				t.Fatal("rejection partially changed pinned identity")
			}
		})
	}
}

func TestPinOwnsKeyBytes(t *testing.T) {
	manager, pin := pinFixture()
	if err := manager.Pin(pin); err != nil {
		t.Fatal(err)
	}
	pin.Target.PublicKey[0] = 9
	if manager.pins[pin.Pair.PairID].Target.PublicKey[0] != 2 {
		t.Fatal("caller can mutate trusted key")
	}
}
