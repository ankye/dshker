package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// Real production Gin process + both production Managers. This intentionally
// enrolls under A, then selects B, without replacing either device/key/certificate.
// The HTTP runtime is a named stub; this is not native UI or real DSH acceptance.
func TestManagersSelectedAccountDiffersFromEnrollmentOwner(t *testing.T) {
	f := newFixture(t)
	original := [2]controlplane.Device{f.config[0].Device, f.config[1].Device}
	// Separate initial enrollment traffic from this scenario's own admission
	// budget, rather than disabling the production per-source limiter.
	time.Sleep(time.Second)
	ctx, cancel := context.WithTimeout(f.ctx, 60*time.Second)
	defer cancel()
	email := "selected-" + protocol.NewID() + "@test.local"
	password := protocol.NewID() + protocol.NewID()
	_, err := f.client.Register(ctx, email, password)
	must(t, err)
	selected, err := f.client.Login(ctx, email, password)
	must(t, err)
	network, err := f.client.CreateNetwork(ctx, selected.Token, "selected-account-network")
	must(t, err)
	for index := range 2 {
		grant, err := f.client.EnrollmentToken(ctx, selected.Token, network.NetworkID)
		must(t, err)
		csr, err := controlplane.DeviceCSR(f.config[index].Private)
		must(t, err)
		device, err := f.client.Enroll(ctx, controlplane.Enrollment{RequestID: protocol.NewID(), Token: grant.Token, CSR: csr, Name: original[index].Name})
		must(t, err)
		// Enrollment replies name the token's selected account; they are not the
		// stored device owner. Verify stored identity with a signed read below.
		if device.DeviceID != original[index].DeviceID || device.UserID != selected.User.UserID ||
			!bytes.Equal(device.PublicKey, original[index].PublicKey) || !bytes.Equal(device.Certificate, original[index].Certificate) {
			t.Fatal("joining selected account replaced original device identity")
		}
		stored, err := f.client.ReadCertificate(ctx, original[index].DeviceID, f.config[index].Private, f.authority)
		must(t, err)
		if stored.UserID != original[index].UserID || stored.DeviceID != original[index].DeviceID ||
			!bytes.Equal(stored.PublicKey, original[index].PublicKey) || !bytes.Equal(stored.Certificate, original[index].Certificate) {
			t.Fatal("selected-account enrollment changed the stored owner, device, key or certificate")
		}
	}
	share, err := f.devices[1].Share(ctx, network.NetworkID)
	must(t, err)
	encoded, err := json.Marshal(share)
	must(t, err)
	pair, err := f.devices[0].Invite(ctx, base64.RawURLEncoding.EncodeToString(encoded))
	must(t, err)
	_, err = f.devices[1].PairAction(ctx, pair.PairID, "approve", "")
	must(t, err)
	_, err = f.devices[0].PairAction(ctx, pair.PairID, "confirm", share.Fingerprint)
	must(t, err)
	legacy, err := f.devices[0].PairIdentity(ctx, pair.PairID)
	must(t, err)
	if legacy.Initiator.UserID != original[0].UserID || legacy.Target.UserID != original[0].UserID {
		t.Fatal("v2 selected account changed the legacy identity projection")
	}
	time.Sleep(time.Second)
	runtimeURL, stopRuntime := startStubDSH(t)
	defer stopRuntime()
	var managers [2]*peersession.Manager
	for _, index := range []int{1, 0} {
		config := f.config[index]
		f.devices[index].SetAccount(selected.User.UserID)
		manager, err := peersession.New(ctx, f.devices[index], peersession.Config{
			Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device,
			PrivateKey: config.Private, CoreInstanceID: integrationCoreInstanceID(t),
		}, []controlplane.PairIdentity{}, func(context.Context, string) (runtimebridge.Binding, error) {
			if index != 1 {
				return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_owner")
			}
			return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
		}, func(peersession.State) {})
		must(t, err)
		t.Cleanup(manager.Close)
		identity, err := manager.PinScopedIdentity(ctx, selected.User.UserID, network.NetworkID, pair.PairID)
		must(t, err)
		if identity.Initiator.UserID != selected.User.UserID || identity.Target.UserID != selected.User.UserID ||
			identity.Pair.PairID != pair.PairID || identity.Pair.NetworkID != network.NetworkID ||
			identity.Initiator.DeviceID != original[0].DeviceID || identity.Target.DeviceID != original[1].DeviceID {
			t.Fatal("fresh scoped identity changed selected account or device scope")
		}
		must(t, manager.ActivateCandidates(ctx))
		managers[index] = manager
	}
	connected, err := managers[0].Connect(ctx, original[1].DeviceID, 1, true)
	must(t, err)
	if connected.State.Stage != "ready" || connected.State.PairID != original[1].DeviceID || !directUDP(connected.State.Path) {
		t.Fatal("selected account did not establish the exact direct workbench", connected.State)
	}
	must(t, runtimebridge.Probe(ctx, connected.URL))
	for index := range 2 {
		if f.config[index].Device.UserID != original[index].UserID || selected.User.UserID == original[index].UserID {
			t.Fatal("selected login was replaced with the enrollment owner")
		}
	}
}
