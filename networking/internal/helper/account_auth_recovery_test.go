package helper

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func authRecoveryFixture(t *testing.T) (*certificateFixture, controlplane.UserSession) {
	t.Helper()
	f, session := authDeviceFixture(t, 2*time.Second)
	leaf, err := f.account.base.ValidateDevice(f.original, f.private, f.account.identity, false)
	if err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(time.Until(leaf.NotAfter) + 25*time.Millisecond)
	defer timer.Stop()
	<-timer.C
	return f, session
}

func authDeviceFixture(t *testing.T, remaining time.Duration) (*certificateFixture, controlplane.UserSession) {
	t.Helper()
	f := newCertificateFixture(t, remaining)
	f.selectedUserID = f.original.UserID
	client, err := f.account.base.WithDevice(f.original, f.private, f.account.identity)
	if err != nil {
		t.Fatal(err)
	}
	client.SetAccount(f.original.UserID)
	manager, err := peersession.New(f.host.ctx, client, peersession.Config{Endpoints: f.account.endpoints, Authority: f.account.identity, Device: f.original, PrivateKey: f.private, CoreInstanceID: protocol.NewNonce()}, []controlplane.PairIdentity{}, func(context.Context, string) (runtimebridge.Binding, error) {
		return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_request")
	}, func(peersession.State) {})
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	f.account.client, f.account.manager, f.account.device, f.account.httpPhase = client, manager, f.original, accountHTTPDevice
	if err := f.host.SaveCredential(f.account.identity.ServiceID, f.original, f.private); err != nil {
		t.Fatal(err)
	}
	session := controlplane.UserSession{User: controlplane.User{UserID: protocol.NewID(), Username: "selected@example.test"}, Token: strings.Repeat("a", 64), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	f.mu.Lock()
	f.loginSession, f.selectedUserID, f.grantSessionToken = &session, session.User.UserID, session.Token
	f.mu.Unlock()
	return f, session
}

func TestAccountAuthValidCertificateKeepsActualWSSFailure(t *testing.T) {
	f, session := authDeviceFixture(t, 30*24*time.Hour)
	f.mu.Lock()
	f.rejectSignalAttempt = 2
	f.mu.Unlock()
	value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
	certificateError(t, err, "p2p.server_unavailable")
	if value != nil || f.account.activationPending != nil || f.account.manager.CandidatesActive() {
		t.Fatal("valid-certificate WSS failure was disguised as pending auth success")
	}
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current.Token != session.Token || f.account.client.Account() != session.User.UserID {
		t.Fatal("valid-phase failure lost the real confirmed B session", err)
	}
}

func TestAuthenticatedCurrentAdoptsNetworkAndPublishesPeersWithoutUserRefresh(t *testing.T) {
	f, session := authDeviceFixture(t, 30*24*time.Hour)
	identity, remote := plantedPair(t, f.original.DeviceID, session.User.UserID, f.original.PublicKey, "Windows computer", f.networkID)
	f.scopedIdentity = &identity
	f.networks = []controlplane.Network{{NetworkID: f.networkID, UserID: session.User.UserID, Name: "shared", MaxDevices: 10}}

	value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
	if err != nil || value.(controlplane.UserSession) != session {
		t.Fatal("login did not confirm the selected account", err)
	}
	value, err = authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != session.User {
		t.Fatal("confirmed login did not complete automatic network synchronization", err)
	}
	f.mu.Lock()
	adoptions := f.adoptions
	lastHello := f.hellos[len(f.hellos)-1]
	helloCount := len(f.hellos)
	f.mu.Unlock()
	if adoptions != 1 || lastHello.UserID != session.User.UserID {
		t.Fatalf("login did not adopt under the confirmed account and publish its WSS identity: adoptions=%d hello=%+v", adoptions, lastHello)
	}
	if _, err = authHandle(f, "user.current", map[string]string{"token": session.Token}); err != nil {
		t.Fatal("re-reading the same confirmed session failed", err)
	}
	f.mu.Lock()
	secondAdoptions := f.adoptions
	secondHelloCount := len(f.hellos)
	f.mu.Unlock()
	if secondAdoptions != 2 {
		t.Fatalf("a second confirmed login/session read did not republish network membership for online peers: got %d adoptions", secondAdoptions)
	}
	if secondHelloCount != helloCount {
		t.Fatalf("confirming the same account unnecessarily replaced its healthy WSS registration: hellos %d→%d", helloCount, secondHelloCount)
	}
	saved, err := f.host.catalog.Inspect()
	if err != nil {
		t.Fatal("catalog readback after authentication failed", err)
	}
	for _, computer := range saved.Record.Computers {
		if computer.ServiceID == f.account.identity.ServiceID && computer.RemoteDeviceID == remote.DeviceID && computer.NetworkID == f.networkID && computer.PairState == "active" {
			return
		}
	}
	t.Fatal("successful login required a separate manual network refresh before the remote computer appeared", saved.Record.Computers)
}

func TestAuthenticatedCurrentWithoutNetworkMembersKeepsEmptyCatalog(t *testing.T) {
	f, session := authDeviceFixture(t, 30*24*time.Hour)
	if _, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"}); err != nil {
		t.Fatal("could not confirm the account before checking an empty network", err)
	}
	if _, err := authHandle(f, "user.current", map[string]string{"token": session.Token}); err != nil {
		t.Fatal("empty network synchronization was refused", err)
	}
	f.mu.Lock()
	adoptions := f.adoptions
	f.mu.Unlock()
	saved, err := f.host.catalog.Inspect()
	if err != nil || adoptions != 1 || len(saved.Record.Computers) != 0 {
		t.Fatal("empty membership synchronization fabricated a computer or skipped the authoritative read", adoptions, saved.Record.Computers, err)
	}
}

func TestNetworkSyncPartialCatalogReadRecoversOnNextAutomaticConfirmation(t *testing.T) {
	f, session := authDeviceFixture(t, 30*24*time.Hour)
	if _, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"}); err != nil {
		t.Fatal("could not confirm the account before the independent list failure", err)
	}
	identity, remote := plantedPair(t, f.original.DeviceID, session.User.UserID, f.original.PublicKey, "Windows computer", f.networkID)
	f.scopedIdentity = &identity
	f.networks = []controlplane.Network{{NetworkID: f.networkID, UserID: session.User.UserID, Name: "shared", MaxDevices: 10}}
	f.mu.Lock()
	f.pairCode = "p2p.server_unavailable"
	f.mu.Unlock()
	if value, err := authHandle(f, "user.current", map[string]string{"token": session.Token}); value != nil || err == nil || err.Error() != "p2p.server_unavailable" {
		t.Fatal("a committed membership with a failed authoritative catalog read was presented as success", value, err)
	}
	f.mu.Lock()
	firstAdoptions := f.adoptions
	f.mu.Unlock()
	partial, err := f.host.catalog.Inspect()
	if err != nil || firstAdoptions != 1 || len(partial.Record.Computers) != 0 {
		t.Fatal("partial catalog refresh fabricated peer data or skipped the actual adoption", firstAdoptions, partial.Record.Computers, err)
	}
	f.mu.Lock()
	f.pairCode = ""
	f.mu.Unlock()
	value, err := authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != session.User {
		t.Fatal("the next automatic account confirmation did not recover the committed network state", err)
	}
	f.mu.Lock()
	secondAdoptions := f.adoptions
	f.mu.Unlock()
	saved, err := f.host.catalog.Inspect()
	if err != nil || secondAdoptions != 2 {
		t.Fatal("automatic recovery did not idempotently republish membership", secondAdoptions, err)
	}
	for _, computer := range saved.Record.Computers {
		if computer.ServiceID == f.account.identity.ServiceID && computer.RemoteDeviceID == remote.DeviceID && computer.NetworkID == f.networkID && computer.PairState == "active" {
			return
		}
	}
	t.Fatal("automatic recovery did not read back the exact active network peer", saved.Record.Computers)
}

func TestOnlinePeerRegistrationRefreshesCatalogAndChoiceInvalidation(t *testing.T) {
	f, session := authDeviceFixture(t, 30*24*time.Hour)
	identity, remote := plantedPair(t, f.original.DeviceID, session.User.UserID, f.original.PublicKey, "Windows computer", f.networkID)
	f.scopedIdentity = &identity
	f.networks = []controlplane.Network{{NetworkID: f.networkID, UserID: session.User.UserID, Name: "shared", MaxDevices: 10}}
	if _, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"}); err != nil {
		t.Fatal("could not establish the selected account for registration refresh", err)
	}
	if _, err := authHandle(f, "user.current", map[string]string{"token": session.Token}); err != nil {
		t.Fatal("could not establish current account scope", err)
	}
	for {
		select {
		case <-f.catalogChanged:
		default:
			goto drained
		}
	}
drained:
	f.mu.Lock()
	previousPairQueries, previousAnnouncements := f.pairQueries, f.catalogAnnouncements
	f.mu.Unlock()
	f.account.peerRegistrationChanged(protocol.PeerRegistration{Version: protocol.ControlVersion, Type: "peer-registration", ServerEpoch: protocol.NewNonce(), DeviceID: remote.DeviceID, UserID: session.User.UserID, CoreInstanceID: protocol.NewNonce(), Capabilities: []string{protocol.CapabilityCandidate}, Online: true})
	select {
	case <-f.catalogChanged:
	case <-time.After(2 * time.Second):
		t.Fatal("online coordinator registration did not notify the shell to refresh network choices")
	}
	f.mu.Lock()
	pairQueries, announcements := f.pairQueries, f.catalogAnnouncements
	f.mu.Unlock()
	if pairQueries <= previousPairQueries || announcements != previousAnnouncements+1 {
		t.Fatalf("registration did not read current pair authority and invalidate the choice view: pair reads %d→%d, announcements %d→%d", previousPairQueries, pairQueries, previousAnnouncements, announcements)
	}
}

func TestAccountAuthExpiredBranchRequiresFullOriginalBinding(t *testing.T) {
	for _, name := range []string{"missing-record", "wrong-key", "invalid-signature"} {
		t.Run(name, func(t *testing.T) {
			f, session := authRecoveryFixture(t)
			want := "p2p.identity_mismatch"
			switch name {
			case "missing-record":
				if err := f.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
				want = "p2p.invalid_device_state"
			case "wrong-key":
				f.account.device.PublicKey = make([]byte, 32)
			case "invalid-signature":
				f.account.device.Certificate = append([]byte(nil), f.original.Certificate...)
				f.account.device.Certificate[len(f.account.device.Certificate)-1] ^= 1
				want = "p2p.invalid_device_certificate"
			}
			value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
			certificateError(t, err, want)
			f.mu.Lock()
			calls := len(f.authRequests)
			f.mu.Unlock()
			if value != nil || calls != 0 || f.account.activationPending != nil || len(f.account.authRecoveryJoins) != 0 {
				t.Fatal("unverified expired state gained public auth/activation authority")
			}
		})
	}
}

func TestAccountAuthExpiredLogoutFailureDoesNotClaimRemoteRevocation(t *testing.T) {
	f, session := authRecoveryFixture(t)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	other := session
	other.Token = strings.Repeat("b", 64)
	f.loginSession = &other
	f.mu.Unlock()
	_, err := authHandle(f, "user.logout", map[string]string{"token": session.Token})
	certificateError(t, err, "p2p.user_unauthorized")
	f.mu.Lock()
	revoked := f.logoutRevoked
	f.mu.Unlock()
	if revoked || f.account.client.Account() != "" || f.account.manager.CandidatesActive() || len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("failed remote revocation was fabricated or local logout fencing was abandoned")
	}
}

func TestAccountAuthIssuedCertificateRequiresExistingExactPendingProvenance(t *testing.T) {
	for _, change := range []string{"missing-source", "wrong-source-client", "wrong-pending-code", "missing-record"} {
		t.Run(change, func(t *testing.T) {
			f, session := authRecoveryFixture(t)
			if _, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"}); err != nil {
				t.Fatal(err)
			}
			if _, err := f.call(f.original, f.networkID, session.Token); err != nil {
				t.Fatal(err)
			}
			want := "p2p.invalid_device_state"
			switch change {
			case "missing-source":
				f.account.activationSource = nil
			case "wrong-source-client":
				f.account.activationSource.client = f.account.base
				want = "p2p.identity_mismatch"
			case "wrong-pending-code":
				f.account.activationPending = errors.New("p2p.server_unavailable")
			case "missing-record":
				if err := f.host.DeleteCredential(f.account.identity.ServiceID); err != nil {
					t.Fatal(err)
				}
			}
			f.mu.Lock()
			before := len(f.authRequests)
			f.mu.Unlock()
			value, err := authHandle(f, "user.current", map[string]string{"token": session.Token})
			certificateError(t, err, want)
			f.mu.Lock()
			after := len(f.authRequests)
			f.mu.Unlock()
			if value != nil || before != after || f.account.manager.CandidatesActive() {
				t.Fatal("valid certificate fabricated recovery provenance or activated corrupt authority")
			}
		})
	}
}

func authHandle(f *certificateFixture, method string, data any) (any, error) {
	encoded, _ := json.Marshal(data)
	payload, _ := json.Marshal(scopedRequest{ServiceID: f.account.identity.ServiceID, Data: encoded})
	return f.host.Handle(context.Background(), method, payload)
}

func TestAccountAuthExpiredHostLoginThenCurrentPublishesRealSession(t *testing.T) {
	f, session := authRecoveryFixture(t)
	value, err := authHandle(f, "user.login", map[string]string{"username": session.User.Username, "password": "test-only-password"})
	if err != nil || value.(controlplane.UserSession) != session {
		t.Fatal("Host.Handle login could not return the authenticated B session for main publication", err)
	}
	value, err = authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != session.User {
		t.Fatal("main's mandatory post-login current-user confirmation could not publish B", err)
	}
	assertAuthRecoveryPending(t, f, session)
}

func TestAccountAuthExpiredHostCurrentAdoptsPersistedRealSession(t *testing.T) {
	f, session := authRecoveryFixture(t)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		t.Fatal(err)
	}
	value, err := authHandle(f, "user.current", map[string]string{"token": session.Token})
	if err != nil || value.(controlplane.User) != session.User {
		t.Fatal("expired device blocked persisted-session adoption", err)
	}
	assertAuthRecoveryPending(t, f, session)
}

func TestAccountAuthExpiredHostLogoutRevokesRemoteToken(t *testing.T) {
	f, session := authRecoveryFixture(t)
	if err := f.host.saveAccountSession(f.account.identity.ServiceID, persistedAccountSession{Token: session.Token, ExpiresAt: session.ExpiresAt}); err != nil {
		t.Fatal(err)
	}
	_, err := authHandle(f, "user.logout", map[string]string{"token": session.Token})
	if err != nil {
		t.Fatal("expired device prevented the actual public token revocation", err)
	}
	f.mu.Lock()
	revoked := f.logoutRevoked
	f.mu.Unlock()
	if !revoked || f.account.client.Account() != "" || f.account.manager.CandidatesActive() {
		t.Fatal("logout did not revoke remote/local selected authority")
	}
	if _, exists, err := f.host.readAccountSession(f.account.identity.ServiceID); err != nil || exists {
		t.Fatal("logout retained durable session", err)
	}
	_, err = f.account.base.CurrentUser(context.Background(), session.Token)
	certificateError(t, err, "p2p.user_unauthorized")
}

func assertAuthRecoveryPending(t *testing.T, f *certificateFixture, session controlplane.UserSession) {
	t.Helper()
	current, exists, err := f.host.readAccountSession(f.account.identity.ServiceID)
	if err != nil || !exists || current.Token != session.Token || current.ExpiresAt != session.ExpiresAt || f.account.client.Account() != session.User.UserID || f.account.device.UserID != f.original.UserID || f.account.manager.CandidatesActive() {
		t.Fatal("auth failed to preserve real B/original A without candidate admission", err)
	}
	if _, err := f.account.manager.CurrentRegistration(session.User.UserID); err == nil {
		t.Fatal("auth falsely retained a usable expired registration")
	}
	certificateError(t, f.account.activationPending, "p2p.certificate_recovery_required")
	if len(f.account.authRecoveryJoins) != 0 {
		t.Fatal("Host.Handle returned without owning and draining its recovery joins")
	}
	f.mu.Lock()
	requests := append([]accountTransportRequest{}, f.authRequests...)
	hellos := len(f.hellos)
	f.mu.Unlock()
	if hellos != 1 || f.runtimeCalls != 0 {
		t.Fatal("expired auth attempted new WSS registration or runtime work", hellos)
	}
	for _, request := range requests {
		if request.deviceID != "" || request.verified {
			t.Fatal("named public auth used expired device mTLS", request.path)
		}
	}
	_, err = authHandle(f, "directory.refresh", struct{}{})
	certificateError(t, err, "p2p.certificate_recovery_required")
}
