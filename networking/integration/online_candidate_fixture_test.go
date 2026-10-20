//go:build live

package integration

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type onlineCandidateInputs struct {
	endpoints   controlplane.Endpoints
	serviceID   string
	publicSPKI  string
	harnessRoot string
}

// Every endpoint and expected identity comes from an explicit external input.
// There is no local coordinator, alternate origin, trust override or old login.
func readOnlineCandidateInputs(getenv func(string) string) (onlineCandidateInputs, error) {
	value := onlineCandidateInputs{
		endpoints: controlplane.Endpoints{
			HTTPSOrigin: getenv("DSHKER_ONLINE_HTTPS_ORIGIN"),
			WSSURL:      getenv("DSHKER_ONLINE_WSS_URL"),
			STUNAddress: getenv("DSHKER_ONLINE_STUN_ADDRESS"),
		},
		serviceID: getenv("DSHKER_ONLINE_SERVICE_ID"), publicSPKI: getenv("DSHKER_ONLINE_PUBLIC_SPKI_SHA256"),
		harnessRoot: getenv("DSHKER_TEST_HARNESS_ROOT"),
	}
	if err := value.endpoints.Validate(); err != nil {
		return onlineCandidateInputs{}, err
	}
	service, err := hex.DecodeString(value.serviceID)
	if err != nil || len(service) != 6 || value.serviceID != strings.ToLower(value.serviceID) {
		return onlineCandidateInputs{}, errors.New("test.online_expected_service_required")
	}
	spki, err := hex.DecodeString(value.publicSPKI)
	if err != nil || len(spki) != sha256.Size || value.publicSPKI != strings.ToLower(value.publicSPKI) {
		return onlineCandidateInputs{}, errors.New("test.online_expected_spki_required")
	}
	if !filepath.IsAbs(value.harnessRoot) || filepath.Clean(value.harnessRoot) != value.harnessRoot {
		return onlineCandidateInputs{}, errors.New("test.online_harness_root_required")
	}
	return value, nil
}

func readOnlineCandidatePassword(input io.Reader) (string, error) {
	reader := bufio.NewReader(io.LimitReader(input, 4097))
	line, err := reader.ReadString('\n')
	if err != nil || len(line) > 4096 {
		return "", errors.New("test.online_password_stdin_required")
	}
	password := strings.TrimSuffix(line, "\n")
	if len(password) < 32 || strings.ContainsAny(password, "\x00\r\n") || strings.TrimSpace(password) != password {
		return "", errors.New("test.online_password_stdin_invalid")
	}
	if _, err := reader.ReadByte(); !errors.Is(err, io.EOF) {
		return "", errors.New("test.online_password_stdin_extra_input")
	}
	return password, nil
}

func onlineCandidateMust(t *testing.T, operation string, err error) {
	t.Helper()
	if err != nil {
		// Raw TLS/network/runtime errors can contain URLs or incidental input.
		// Emit only a known refusal or a stable test-side failure classification.
		t.Fatalf("online operation=%s code=%s", operation, hostColdError(err))
	}
}

func onlineCandidateIdentity(inputs onlineCandidateInputs, identity controlplane.Identity) error {
	certificate, err := x509.ParseCertificate(identity.Certificate)
	if err != nil {
		return errors.New("test.online_invalid_identity_certificate")
	}
	digest := sha256.Sum256(certificate.RawSubjectPublicKeyInfo)
	if identity.ServiceID != inputs.serviceID || hex.EncodeToString(digest[:]) != inputs.publicSPKI {
		return errors.New("test.online_service_pin_mismatch")
	}
	return nil
}

func onlineCandidateTLS(t *testing.T, ctx context.Context, inputs onlineCandidateInputs) {
	t.Helper()
	origin, err := url.Parse(inputs.endpoints.HTTPSOrigin)
	onlineCandidateMust(t, "tls-origin", err)
	dialer := tls.Dialer{Config: &tls.Config{MinVersion: tls.VersionTLS13, ServerName: origin.Hostname()}}
	connection, err := dialer.DialContext(ctx, "tcp", origin.Host)
	onlineCandidateMust(t, "system-tls-chain", err)
	defer connection.Close()
	secure, ok := connection.(*tls.Conn)
	if !ok || len(secure.ConnectionState().VerifiedChains) == 0 {
		t.Fatal("system TLS did not return a verified public trust chain")
	}
	t.Logf("online-public-tls trustedSystemChain=true minTLS=1.3 origin=%s", inputs.endpoints.HTTPSOrigin)
}

type onlineCandidateFixture struct {
	*fixture
	inputs      onlineCandidateInputs
	network     controlplane.Network
	pair        controlplane.Pair
	hostWorkers *onlineCandidateWorkers
}

func newOnlineCandidateFixture(t *testing.T, ctx context.Context, inputs onlineCandidateInputs, password string) *onlineCandidateFixture {
	t.Helper()
	client, err := controlplane.New(inputs.endpoints, nil)
	onlineCandidateMust(t, "public-client", err)
	t.Cleanup(client.Close)
	identity, err := client.Identity(ctx, nil)
	onlineCandidateMust(t, "nonce-signed-service-identity", err)
	onlineCandidateMust(t, "explicit-service-spki-pin", onlineCandidateIdentity(inputs, identity))
	pinned, err := client.Identity(ctx, identity.PublicKey)
	onlineCandidateMust(t, "pinned-service-identity", err)
	onlineCandidateMust(t, "pinned-spki-readback", onlineCandidateIdentity(inputs, pinned))
	if pinned.Nonce == identity.Nonce || !bytes.Equal(pinned.Certificate, identity.Certificate) {
		t.Fatal("pinned identity reused nonce or changed service CA")
	}
	username := "online-candidate-" + protocol.NewNonce() + "@test.local"
	created, err := client.Register(ctx, username, password)
	onlineCandidateMust(t, "new-random-user-register", err)
	session, err := client.Login(ctx, username, password)
	onlineCandidateMust(t, "new-random-user-login", err)
	if session.User != created || session.User.Username != username {
		t.Fatal("new random account login did not read back the exact created user")
	}
	f := &onlineCandidateFixture{fixture: &fixture{ctx: ctx, endpoints: inputs.endpoints, client: client, authority: identity, userSession: session}, inputs: inputs}
	t.Cleanup(func() { f.cleanup(t) })
	f.network, err = client.CreateNetwork(ctx, session.Token, "online-candidate-"+protocol.NewID())
	onlineCandidateMust(t, "new-owned-network", err)
	if !protocol.ValidID(f.network.NetworkID) || f.network.UserID != created.UserID {
		t.Fatal("created network did not belong to this run's new account")
	}
	for index := range 2 {
		grant, err := client.EnrollmentToken(ctx, session.Token, f.network.NetworkID)
		onlineCandidateMust(t, "owned-enrollment-token", err)
		private, csr, err := controlplane.NewDeviceKey()
		onlineCandidateMust(t, "new-device-key-and-csr", err)
		device, err := client.Enroll(ctx, controlplane.Enrollment{RequestID: protocol.NewID(), Token: grant.Token, CSR: csr, Name: "online-candidate-" + protocol.NewID()})
		onlineCandidateMust(t, "new-device-enrollment", err)
		f.config[index] = childConfig{Endpoints: inputs.endpoints, Authority: identity, Device: device, Private: private}
		if device.UserID != created.UserID || !bytes.Equal(device.PublicKey, private.Public().(ed25519.PublicKey)) {
			t.Fatal("new device enrollment changed account or generated public key")
		}
		f.devices[index], err = client.WithDevice(device, private, identity)
		onlineCandidateMust(t, "new-device-mtls-client", err)
		f.devices[index].SetAccount(created.UserID)
	}
	if f.config[0].Device.DeviceID == f.config[1].Device.DeviceID || bytes.Equal(f.config[0].Device.PublicKey, f.config[1].Device.PublicKey) {
		t.Fatal("independent device enrollment aliased a device identity or key")
	}
	share, err := f.devices[1].Share(ctx, f.network.NetworkID)
	onlineCandidateMust(t, "owned-device-share", err)
	encoded, err := json.Marshal(share)
	onlineCandidateMust(t, "share-encoding", err)
	code := base64.RawURLEncoding.EncodeToString(encoded)
	_, err = controlplane.VerifyShare(code, identity, f.network.NetworkID, f.config[0].Device.DeviceID, time.Now())
	onlineCandidateMust(t, "signed-share-validation", err)
	f.pair, err = f.devices[0].Invite(ctx, code)
	onlineCandidateMust(t, "owned-pair-invite", err)
	_, err = f.devices[1].PairAction(ctx, f.pair.PairID, "approve", "")
	onlineCandidateMust(t, "owned-pair-approve", err)
	f.pair, err = f.devices[0].PairAction(ctx, f.pair.PairID, "confirm", share.Fingerprint)
	onlineCandidateMust(t, "owned-pair-confirm", err)
	if f.pair.NetworkID != f.network.NetworkID || f.pair.Initiator != f.config[0].Device.DeviceID || f.pair.Target != f.config[1].Device.DeviceID || f.pair.State != "active" {
		t.Fatal("confirmed pair changed this run's exact new network or device scope")
	}
	t.Logf("online-owned-scope service=%s user=%s network=%s pairRow=%s source=%s target=%s originalUserStateOpened=false", identity.ServiceID, created.UserID, f.network.NetworkID, f.pair.PairID, f.config[0].Device.DeviceID, f.config[1].Device.DeviceID)
	return f
}

// No account/device record deletion operation exists in this client contract.
// Remove only this run's pair, memberships and network, then revoke its session.
func (f *onlineCandidateFixture) cleanup(t *testing.T) {
	t.Helper()
	defer func() {
		for _, client := range f.devices {
			if client != nil {
				client.Close()
			}
		}
	}()
	if f.hostWorkers != nil && !f.hostWorkers.isJoined() {
		t.Errorf("online remote scope cleanup refused: Host workers were not joined; retained service=%s user=%s network=%s pair=%s source=%s target=%s", f.authority.ServiceID, f.userSession.User.UserID, f.network.NetworkID, f.pair.PairID, f.config[0].Device.DeviceID, f.config[1].Device.DeviceID)
		return
	}
	client := f.devices[0]
	if client == nil {
		t.Errorf("online scope cleanup requires this run's exact enrolled source transport; retained service=%s user=%s network=%s pair=%s", f.authority.ServiceID, f.userSession.User.UserID, f.network.NetworkID, f.pair.PairID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	check := func(operation string, err error) {
		if err != nil {
			t.Errorf("online cleanup operation=%s code=%s", operation, hostColdError(err))
		}
	}
	if f.pair.PairID != "" {
		check("delete-owned-pair", client.DeletePair(ctx, f.userSession.Token, f.network.NetworkID, f.pair.PairID))
	}
	if f.network.NetworkID != "" {
		for _, config := range f.config {
			if config.Device.DeviceID != "" {
				check("unbind-owned-device", client.UnbindDevice(ctx, f.userSession.Token, f.network.NetworkID, config.Device.DeviceID))
			}
		}
		check("delete-owned-network", client.DeleteNetwork(ctx, f.userSession.Token, f.network.NetworkID))
	}
	networks, err := client.Networks(ctx, f.userSession.Token)
	check("owned-network-removal-readback", err)
	if err == nil && len(networks) != 0 {
		t.Error("online cleanup left network authority on this run's new account")
	}
	for _, config := range f.config {
		if config.Device.DeviceID != "" {
			t.Logf("online-residual-record service=%s user=%s device=%s accountRecordRetained=true deviceRecordRetained=true accountNetworkCount=%d networkReadbackSucceeded=%t", f.authority.ServiceID, f.userSession.User.UserID, config.Device.DeviceID, len(networks), err == nil)
		}
	}
	check("logout-owned-session", client.Logout(ctx, f.userSession.Token))
	t.Logf("online-cleanup service=%s user=%s network=%s onlyNewRunResources=true accountNetworkCount=%d networkReadbackSucceeded=%t", f.authority.ServiceID, f.userSession.User.UserID, f.network.NetworkID, len(networks), err == nil)
}
