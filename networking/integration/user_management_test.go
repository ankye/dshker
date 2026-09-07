package integration

import (
	"bytes"
	"testing"
	"time"
)

func TestUserNetworkManagementReadback(t *testing.T) {
	f := newFixture(t)
	// Separate enrollment setup from this explicit normal-operation scenario;
	// preserve the real server's per-source request admission limit.
	time.Sleep(time.Second)
	token := f.userSession.Token
	user, err := f.client.CurrentUser(f.ctx, token)
	must(t, err)
	if user != f.userSession.User {
		t.Fatal("user readback identity mismatch")
	}
	devices, err := f.client.UserDevices(f.ctx, token)
	must(t, err)
	if len(devices) != 2 {
		t.Fatal("device inventory mismatch")
	}
	for _, device := range devices {
		if device.UserID != user.UserID {
			t.Fatal("cross-user device returned")
		}
		matched := false
		for _, original := range f.config {
			if device.DeviceID == original.Device.DeviceID {
				matched = bytes.Equal(device.PublicKey, original.Device.PublicKey) && bytes.Equal(device.Certificate, original.Device.Certificate)
			}
		}
		if !matched {
			t.Fatal("device identity changed during readback")
		}
	}
	network, err := f.client.CreateNetwork(f.ctx, token, "management-original")
	must(t, err)
	renamed, err := f.client.RenameNetwork(f.ctx, token, network.NetworkID, "management-renamed")
	must(t, err)
	if renamed.NetworkID != network.NetworkID || renamed.UserID != user.UserID || renamed.Name != "management-renamed" {
		t.Fatal("rename altered network identity")
	}
	unchanged, err := f.client.RenameNetwork(f.ctx, token, network.NetworkID, renamed.Name)
	must(t, err)
	if unchanged != renamed {
		t.Fatal("no-op rename altered network")
	}
	device := f.config[0].Device
	must(t, f.client.BindDevice(f.ctx, token, network.NetworkID, device.DeviceID))
	bound, err := f.client.NetworkDevices(f.ctx, token, network.NetworkID)
	must(t, err)
	if len(bound) != 1 || bound[0].DeviceID != device.DeviceID || bound[0].UserID != user.UserID || !bytes.Equal(bound[0].PublicKey, device.PublicKey) {
		t.Fatal("binding readback mismatch")
	}
	must(t, f.client.UnbindDevice(f.ctx, token, network.NetworkID, device.DeviceID))
	bound, err = f.client.NetworkDevices(f.ctx, token, network.NetworkID)
	must(t, err)
	if len(bound) != 0 {
		t.Fatal("unbind did not persist")
	}
	must(t, f.client.DeleteNetwork(f.ctx, token, network.NetworkID))
	networks, err := f.client.Networks(f.ctx, token)
	must(t, err)
	for _, current := range networks {
		if current.NetworkID == network.NetworkID {
			t.Fatal("deleted network still present")
		}
	}
	if len(networks) != 1 || networks[0].NetworkID != f.config[0].Pin.Pair.NetworkID {
		t.Fatal("delete affected unrelated network")
	}
	pairs, err := f.client.NetworkPairs(f.ctx, token, networks[0].NetworkID)
	must(t, err)
	if len(pairs) != 1 || pairs[0] != f.config[0].Pin.Pair {
		t.Fatal("pair identity readback mismatch")
	}
	must(t, f.client.Logout(f.ctx, token))
	_, err = f.client.CurrentUser(f.ctx, token)
	if err == nil || err.Error() != "p2p.user_unauthorized" {
		t.Fatalf("logged out session accepted: %v", err)
	}
}
