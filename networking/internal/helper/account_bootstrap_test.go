package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestOwnCredentialMaintenanceRevalidatesActiveSelectedAccount(t *testing.T) {
	for _, kind := range []string{"changed-account", "signed-out"} {
		t.Run(kind, func(t *testing.T) {
			f, session := bootstrapFixture(t)
			if count := f.host.RestoreOwnCredentials(context.Background()); count != 1 {
				t.Fatal("initial selected account was not activated", count)
			}
			manager := f.account.manager
			f.mu.Lock()
			previous := *f.scopedIdentity
			selected := ""
			if kind == "changed-account" {
				selected = protocol.NewID()
				for selected == f.selectedUserID || selected == f.original.UserID {
					selected = protocol.NewID()
				}
				f.networkID = protocol.NewID()
				fresh, _ := plantedPair(t, f.original.DeviceID, selected, f.original.PublicKey, "new account remote", f.networkID)
				fresh.Initiator.Presence, fresh.Target.Presence = "online", "offline"
				f.scopedIdentity = &fresh
			}
			f.selectedUserID = selected
			f.mu.Unlock()
			if selected == "" {
				if err := f.host.deleteAccountSession(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
			} else {
				session.Token = strings.Repeat("b", 64)
				if err := f.host.saveAccountSession(f.account.identity.ServiceID, session); err != nil {
					t.Fatal(err)
				}
			}
			if count := f.host.RestoreOwnCredentials(context.Background()); count != 1 {
				t.Fatal("current selected scope did not complete its bootstrap barrier", count)
			}
			if f.account.manager != manager || f.account.client.Account() != selected || manager.CandidatesActive() != (selected != "") {
				t.Fatal("active maintenance reported success without adopting verified selected scope")
			}
			if err := manager.Pin(previous); err == nil {
				t.Fatal("previous account pin remained admissible after selected scope changed")
			}
			f.mu.Lock()
			hellos := append([]protocol.ControlHello(nil), f.hellos...)
			requests := append([]protocol.PairIdentityRequest(nil), f.identityRequests...)
			runtimeCalls := f.runtimeCalls
			f.mu.Unlock()
			if runtimeCalls != 0 || len(hellos) < 3 || hellos[2].UserID != selected || len(hellos[2].Capabilities) != 0 {
				t.Fatal("account transition skipped read-only registration or started DSH", hellos)
			}
			for _, hello := range hellos {
				if hello.CoreInstanceID != hellos[0].CoreInstanceID {
					t.Fatal("account transition replaced the owning core")
				}
			}
			saved, err := f.host.catalog.Inspect()
			if err != nil {
				t.Fatal(err)
			}
			if selected != "" {
				if len(hellos) != 4 || !protocol.HasCapability(hellos[3].Capabilities, protocol.CapabilityCandidate) ||
					len(requests) != 2 || requests[1].UserID != selected || requests[1].Registration == requests[0].Registration ||
					len(saved.Record.Computers) != 2 {
					t.Fatal("changed account did not freshly pin and activate its exact scope", hellos, requests, saved)
				}
				var active int
				for _, computer := range saved.Record.Computers {
					if computer.PairState == "active" {
						active++
						if computer.UserID != selected || computer.NetworkID != f.networkID {
							t.Fatal("fresh catalog retained active authority for the previous account", computer)
						}
					}
				}
				if active != 1 {
					t.Fatal("selected account did not replace prior usable catalog authority", saved)
				}
			} else {
				if len(hellos) != 3 || len(requests) != 1 {
					t.Fatal("signed-out maintenance inferred fresh account authority", hellos, requests)
				}
				for _, computer := range saved.Record.Computers {
					if computer.PairState == "active" {
						t.Fatal("signed-out maintenance kept a usable old-scope computer")
					}
				}
			}
			stored, err := f.host.LoadCredential(f.account.identity.ServiceID)
			if err != nil || stored.DeviceID != f.original.DeviceID || stored.UserID != f.original.UserID ||
				!bytes.Equal(stored.PublicKey, f.original.PublicKey) || !bytes.Equal(stored.PrivateKey, f.private) || !bytes.Equal(stored.Certificate, f.original.Certificate) {
				t.Fatal("account transition changed original enrollment identity", err)
			}
			current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
			if err != nil || exists != (selected != "") || exists && current != session {
				t.Fatal("maintenance rewrote selected session authority", err)
			}
		})
	}
}

func TestSelectedAccountCatalogBootstrapStaysReadOnlyUntilEveryFreshPinSucceeds(t *testing.T) {
	f := newCertificateFixture(t, 30*24*time.Hour)
	f.selectedUserID = protocol.NewID()
	for f.selectedUserID == f.original.UserID {
		f.selectedUserID = protocol.NewID()
	}
	identity, remote := plantedPair(t, f.original.DeviceID, f.selectedUserID, f.original.PublicKey, "remote", f.networkID)
	identity.Initiator.Presence, identity.Target.Presence = "online", "offline"
	f.scopedIdentity = &identity
	f.identityCode = "p2p.pair_revoked"
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"serviceId": f.account.identity.ServiceID, "data": map[string]any{"device": f.original, "privateKey": f.private, "pins": []controlplane.PairIdentity{}, "accountUserId": f.selectedUserID}})
	if _, err := f.host.Handle(context.Background(), "device.restore", payload); err == nil || err.Error() != "p2p.pair_revoked" {
		t.Fatal("failed fresh pin was swallowed by restore", err)
	}
	f.mu.Lock()
	if len(f.hellos) != 1 || f.hellos[0].Capabilities == nil || len(f.hellos[0].Capabilities) != 0 || f.hellos[0].UserID != f.selectedUserID {
		t.Error("failed bootstrap advertised candidates", f.hellos)
	}
	f.identityCode = ""
	f.mu.Unlock()
	saved, err := f.host.catalog.Inspect()
	if err != nil || len(saved.Record.Computers) != 0 {
		t.Fatal("failed live pin was recorded as a usable computer", saved, err)
	}
	if _, err := f.host.Handle(context.Background(), "device.restore", payload); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	if len(f.hellos) != 2 || !protocol.HasCapability(f.hellos[1].Capabilities, protocol.CapabilityCandidate) || f.hellos[0].CoreInstanceID != f.hellos[1].CoreInstanceID {
		t.Error("fresh completion did not activate the same core", f.hellos)
	}
	f.mu.Unlock()
	saved, err = f.host.catalog.Inspect()
	if err != nil || len(saved.Record.Computers) != 1 || saved.Record.Computers[0].UserID != f.selectedUserID || saved.Record.Computers[0].PairID != remote.DeviceID || f.account.device.UserID != f.original.UserID {
		t.Fatal("catalog borrowed enrolled owner or SQL row id", saved, err)
	}
}

func TestRestoreRefusesCachedOrNullPinsBeforeDeviceActivation(t *testing.T) {
	for _, kind := range []string{"null", "cached"} {
		f := newCertificateFixture(t, 30*24*time.Hour)
		var pins any
		want := "p2p.invalid_device_state"
		if kind == "cached" {
			identity, _ := plantedPair(t, f.original.DeviceID, f.original.UserID, f.original.PublicKey, "remote", f.networkID)
			pins, want = []controlplane.PairIdentity{identity}, "p2p.invalid_request"
		}
		payload, _ := json.Marshal(map[string]any{"device": f.original, "privateKey": f.private, "pins": pins, "accountUserId": ""})
		if _, err := f.host.restore(context.Background(), f.account, payload); err == nil || err.Error() != want {
			t.Fatal("cached/null pins reached activation", err)
		}
		if f.account.manager != nil || f.subscriptions != 0 || f.queries != 0 {
			t.Fatal("invalid restore mutated device or registration")
		}
	}
}
