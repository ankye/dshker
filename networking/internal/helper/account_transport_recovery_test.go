package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestAccountTransportExpiredHostAuthAndLegacyScopeRecoverOriginalIdentity(t *testing.T) {
	f, session := authRecoveryFixture(t)
	selected := session.User
	client, manager := f.account.client, f.account.manager
	value, err := authHandle(f, "user.login", map[string]string{"username": selected.Username, "password": "test-only-password"})
	if err != nil || value.(controlplane.UserSession) != session {
		t.Fatal("Host login did not return a publishable real session", err)
	}
	value, err = authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != selected {
		t.Fatal("mandatory main current-user read blocked session publication", err)
	}
	assertAuthRecoveryPending(t, f, session)
	// The legacy record deliberately has no recovery network. Read the new
	// authorization projection before applying an explicitly remembered choice;
	// production main's selection/abort checks have their own shell regressions.
	metadata, err := f.host.loadCertificateMetadata(f.account.identity.ServiceID)
	if err != nil || metadata.NetworkID != "" {
		t.Fatal("fixture is not an original legacy record without network metadata", err)
	}
	f.mu.Lock()
	f.networkDevices = []controlplane.DeviceEntry{{DeviceID: f.original.DeviceID, UserID: f.original.UserID, Name: f.original.Name, Presence: "offline"}}
	f.mu.Unlock()
	before, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID))
	scopeData, _ := json.Marshal(map[string]string{"deviceId": f.original.DeviceID, "token": session.Token})
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: scopeData})
	projection, err := f.host.Handle(context.Background(), "device.certificate_recovery_scope", payload)
	if err != nil {
		t.Fatal("expired real TLS client prevented the named legacy scope read", err)
	}
	scope := projection.(certificateRecoveryScope)
	if scope.User != selected || len(scope.Networks) != 1 || scope.Networks[0].NetworkID != f.networkID || scope.Networks[0].UserID != selected.UserID || len(scope.Networks[0].Devices) != 1 || scope.Networks[0].Devices[0].UserID != f.original.UserID {
		t.Fatal("legacy scope substituted enrollment A for selected B or lost the original membership")
	}
	if after, _ := json.Marshal(f.account.snapshot(f.account.identity.ServiceID)); !bytes.Equal(before, after) {
		t.Fatal("legacy scope changed ordinary directory revision/cache")
	}
	// This exact value represents the user's existing remembered selection. Do
	// not infer it from a sole result or persist it during scope discovery.
	rememberedNetworkID := f.networkID
	if scope.Networks[0].NetworkID != rememberedNetworkID {
		t.Fatal("fresh scope does not authorize the handpicked recovery network")
	}
	result, err := f.call(f.original, rememberedNetworkID, session.Token)
	if err != nil || f.recoveries != 1 || f.grants != 1 || bytes.Equal(result.Certificate, f.original.Certificate) {
		t.Fatal("confirmed B could not use the existing named original-key recovery", err)
	}
	certificateError(t, f.account.activationPending, "p2p.certificate_recovery_required")
	// Main's reportedAccount/current-user read occurs after issuance but before
	// device.restore. Only the established recovery provenance admits this gap.
	f.mu.Lock()
	authBefore, helloBefore := len(f.authRequests), len(f.hellos)
	f.mu.Unlock()
	value, err = authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != selected || f.account.manager.CandidatesActive() {
		t.Fatal("post-issuance authentication was rebound to premature device activation", err)
	}
	f.mu.Lock()
	authRequests := append([]accountTransportRequest{}, f.authRequests[authBefore:]...)
	helloAfter := len(f.hellos)
	f.mu.Unlock()
	if len(authRequests) != 1 || authRequests[0].path != "/v1/user" || !authRequests[0].verified || authRequests[0].deviceID != f.original.DeviceID || !authRequests[0].bearer || helloAfter != helloBefore {
		t.Fatal("valid pending auth lost original mTLS attribution, fresh B read or activation fence")
	}
	certificateError(t, f.account.activationPending, "p2p.certificate_recovery_required")
	fresh, remote := plantedPair(t, f.original.DeviceID, selected.UserID, f.original.PublicKey, "explicit recovery peer", f.networkID)
	fresh.Initiator.Presence, fresh.Target.Presence = "online", "offline"
	f.mu.Lock()
	f.scopedIdentity = &fresh
	f.mu.Unlock()
	device := f.original
	device.Certificate = result.Certificate
	_, err = authHandle(f, "device.restore", map[string]any{"device": device, "privateKey": f.private, "pins": []controlplane.PairIdentity{}, "accountUserId": selected.UserID})
	if err != nil {
		t.Fatal("recovered identity did not complete the real named restore barrier", err)
	}
	if f.account.client != client || f.account.manager != manager || f.account.httpPhase != accountHTTPDevice || f.account.device.DeviceID != f.original.DeviceID || f.account.device.UserID != f.original.UserID || !bytes.Equal(f.account.device.PublicKey, f.original.PublicKey) || client.Account() != selected.UserID || !manager.CandidatesActive() || f.account.activationPending != nil || f.account.activationSource != nil {
		t.Fatal("recovery replaced original device owner A or selected account B")
	}
	stored, err := f.host.LoadCredential(f.account.identity.ServiceID)
	if err != nil || stored.UserID != f.original.UserID || stored.DeviceID != f.original.DeviceID || !bytes.Equal(stored.PrivateKey, f.private) || !bytes.Equal(stored.PublicKey, f.original.PublicKey) {
		t.Fatal("recovery changed the durable original key or enrollment identity", err)
	}
	f.mu.Lock()
	hellos := append([]protocol.ControlHello{}, f.hellos...)
	identities := append([]protocol.PairIdentityRequest{}, f.identityRequests...)
	f.mu.Unlock()
	if len(hellos) != 3 || hellos[1].UserID != selected.UserID || len(hellos[1].Capabilities) != 0 || hellos[2].UserID != selected.UserID || !protocol.HasCapability(hellos[2].Capabilities, protocol.CapabilityCandidate) || hellos[0].CoreInstanceID != hellos[1].CoreInstanceID || hellos[1].CoreInstanceID != hellos[2].CoreInstanceID {
		t.Fatal("recovery bypassed B's same-core read-only registration and fresh activation", hellos)
	}
	if len(identities) != 1 || identities[0].UserID != selected.UserID || identities[0].NetworkID != f.networkID || identities[0].PairID != fresh.Pair.PairID || identities[0].Registration.CoreInstanceID != hellos[1].CoreInstanceID {
		t.Fatal("recovery activated without the exact fresh B/network/pair registration read")
	}
	saved, err := f.host.catalog.Inspect()
	if err != nil || len(saved.Record.Computers) != 1 || saved.Record.Computers[0].RemoteDeviceID != remote.DeviceID || saved.Record.Computers[0].UserID != selected.UserID || saved.Record.Computers[0].NetworkID != f.networkID {
		t.Fatal("recovery activated without persisting the fresh scoped pin", err)
	}
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current.Token != session.Token || current.ExpiresAt != session.ExpiresAt || f.runtimeCalls != 0 {
		t.Fatal("recovery rewrote selected session or activated a runtime", err)
	}
}
