package helper

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// directoryCoordinator is a coordinator that answers the three reads the
// directory is built from, so a test can change one device and watch the core's
// snapshot follow.
type directoryCoordinator struct {
	mu       sync.Mutex
	networks []controlplane.Network
	devices  map[string][]controlplane.DeviceEntry
	account  []controlplane.DeviceEntry
	calls    []string
}

func (fake *directoryCoordinator) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fake.mu.Lock()
		fake.calls = append(fake.calls, request.URL.Path)
		networks := append([]controlplane.Network(nil), fake.networks...)
		account := append([]controlplane.DeviceEntry(nil), fake.account...)
		members := map[string][]controlplane.DeviceEntry{}
		for id, devices := range fake.devices {
			members[id] = append([]controlplane.DeviceEntry(nil), devices...)
		}
		fake.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/v1/logout":
			_, _ = writer.Write([]byte(`{"loggedOut":true}`))
		case request.URL.Path == "/v1/networks":
			if networks == nil {
				networks = []controlplane.Network{}
			}
			_ = json.NewEncoder(writer).Encode(networks)
		case request.URL.Path == "/v1/devices":
			if account == nil {
				account = []controlplane.DeviceEntry{}
			}
			_ = json.NewEncoder(writer).Encode(account)
		case strings.HasPrefix(request.URL.Path, "/v1/networks/") && strings.HasSuffix(request.URL.Path, "/devices"):
			id := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/v1/networks/"), "/devices")
			members := members[id]
			if members == nil {
				members = []controlplane.DeviceEntry{}
			}
			_ = json.NewEncoder(writer).Encode(members)
		default:
			t.Errorf("unexpected call: %s", request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
		}
	})
}

func (fake *directoryCoordinator) member(networkID string, device controlplane.DeviceEntry) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.devices[networkID] = append(fake.devices[networkID], device)
}

// announceRecorder stands in for the shell on the parent channel.
type announceRecorder struct {
	mu    sync.Mutex
	calls []string
	seen  chan struct{}
}

func newAnnounceRecorder() *announceRecorder {
	return &announceRecorder{seen: make(chan struct{}, 16)}
}

func (recorder *announceRecorder) Call(_ context.Context, method string, payload any) (json.RawMessage, error) {
	recorder.mu.Lock()
	recorder.calls = append(recorder.calls, method)
	recorder.mu.Unlock()
	if method == "directory.changed" {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		recorder.mu.Lock()
		recorder.calls[len(recorder.calls)-1] = method + " " + string(encoded)
		recorder.mu.Unlock()
		recorder.seen <- struct{}{}
	}
	return json.RawMessage(`{}`), nil
}

func (recorder *announceRecorder) announcements() []string {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]string(nil), recorder.calls...)
}

// newDirectoryClient talks to one fake coordinator over TLS, exactly as the
// shell-composed core does.
func newDirectoryClient(t *testing.T, handler http.Handler) *controlplane.Client {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := controlplane.New(controlplane.Endpoints{
		HTTPSOrigin: server.URL,
		WSSURL:      strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals",
		STUNAddress: "127.0.0.1:3478",
	}, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

// directoryAccount composes one account over the fake coordinator.
func directoryAccount(t *testing.T, fake *directoryCoordinator) (*Host, *account, *announceRecorder) {
	t.Helper()
	host := New(context.Background())
	recorder := newAnnounceRecorder()
	host.BindMain(recorder)
	account := &account{
		base:     newDirectoryClient(t, fake.handler(t)),
		identity: controlplane.Identity{ServiceID: protocol.NewID()},
		host:     host,
	}
	host.accounts[account.identity.ServiceID] = account
	return host, account, recorder
}

// The directory is the core's own copy: one read fills it, and a second read that
// finds the same coordinator state must not move the revision the shell mirrors.
func TestDirectorySnapshotIsReadAndOnlyMovesWhenItsContentDoes(t *testing.T) {
	fake := &directoryCoordinator{
		networks: []controlplane.Network{{NetworkID: protocol.NewID(), UserID: protocol.NewID(), Name: "mywork", MaxDevices: 10}},
		devices:  map[string][]controlplane.DeviceEntry{},
		account:  []controlplane.DeviceEntry{{DeviceID: protocol.NewID(), Name: "this machine"}},
	}
	_, account, recorder := directoryAccount(t, fake)
	fake.member(fake.networks[0].NetworkID, controlplane.DeviceEntry{DeviceID: protocol.NewID(), Name: "Mac", Presence: "online", LastSeen: 1_789_445_714, Version: "0.1.42", Platform: "darwin", Architecture: "arm64"})
	account.rememberToken(strings.Repeat("a", 64))

	view, err := account.refreshDirectory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !view.Known || view.Revision != 1 || len(view.Networks) != 1 || len(view.Networks[0].Devices) != 1 || len(view.Devices) != 1 {
		t.Fatalf("first read did not fill the snapshot: %+v", view)
	}
	if view.Networks[0].Devices[0].Presence != "online" || view.Networks[0].Devices[0].Version != "0.1.42" {
		t.Fatalf("member details were not carried through: %+v", view.Networks[0].Devices[0])
	}

	again, err := account.refreshDirectory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if again.Revision != 1 {
		t.Fatalf("an unchanged directory moved the revision: %d", again.Revision)
	}

	fake.member(fake.networks[0].NetworkID, controlplane.DeviceEntry{DeviceID: protocol.NewID(), Name: "second"})
	third, err := account.refreshDirectory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if third.Revision != 2 || len(third.Networks[0].Devices) != 2 {
		t.Fatalf("a changed directory did not move the revision: %+v", third)
	}

	announcements := recorder.announcements()
	want := []string{
		`directory.changed {"serviceId":"` + account.identity.ServiceID + `","revision":1}`,
		`directory.changed {"serviceId":"` + account.identity.ServiceID + `","revision":2}`,
	}
	if len(announcements) != len(want) || announcements[0] != want[0] || announcements[1] != want[1] {
		t.Fatalf("the shell was not told exactly when the snapshot changed: %v", announcements)
	}
}

// A core with no session cannot maintain anything, and says so with the code the
// shell already maps to "sign in".
func TestDirectoryRefreshWithoutASessionIsRefused(t *testing.T) {
	fake := &directoryCoordinator{devices: map[string][]controlplane.DeviceEntry{}}
	_, account, _ := directoryAccount(t, fake)
	if _, err := account.refreshDirectory(context.Background()); err == nil || err.Error() != "p2p.user_login_required" {
		t.Fatalf("refresh without a session = %v, want p2p.user_login_required", err)
	}
}

// The first token-bearing call a restarted shell makes is what starts the
// maintenance: no separate handshake, and no page has to be opened first.
func TestTokenBearingCallTeachesTheCoreAndStartsTheMaintenance(t *testing.T) {
	fake := &directoryCoordinator{
		networks: []controlplane.Network{{NetworkID: protocol.NewID(), UserID: protocol.NewID(), Name: "mywork", MaxDevices: 10}},
		devices:  map[string][]controlplane.DeviceEntry{},
	}
	host, account, recorder := directoryAccount(t, fake)
	fake.member(fake.networks[0].NetworkID, controlplane.DeviceEntry{DeviceID: protocol.NewID(), Name: "Mac", Presence: "online"})

	payload, err := json.Marshal(map[string]string{"token": strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.manage(context.Background(), account, "devices.list", payload); err != nil {
		t.Fatal(err)
	}
	select {
	case <-recorder.seen:
	case <-time.After(5 * time.Second):
		t.Fatal("a token-bearing read did not start the directory maintenance")
	}
	view := account.snapshot(account.identity.ServiceID)
	if !view.Known || len(view.Networks) != 1 || len(view.Networks[0].Devices) != 1 {
		t.Fatalf("the snapshot was not filled from the session the shell handed over: %+v", view)
	}
}

// Signing out must not leave the previous account's devices on screen.
func TestLogoutClearsTheMaintainedDirectory(t *testing.T) {
	fake := &directoryCoordinator{
		networks: []controlplane.Network{{NetworkID: protocol.NewID(), UserID: protocol.NewID(), Name: "mywork", MaxDevices: 10}},
		devices:  map[string][]controlplane.DeviceEntry{},
	}
	host, account, _ := directoryAccount(t, fake)
	account.rememberToken(strings.Repeat("c", 64))
	if _, err := account.refreshDirectory(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !account.snapshot(account.identity.ServiceID).Known {
		t.Fatal("the snapshot was not filled before signing out")
	}
	payload := json.RawMessage(`{"token":"` + strings.Repeat("c", 64) + `"}`)
	if _, err := host.manage(context.Background(), account, "user.logout", payload); err != nil {
		t.Fatal(err)
	}
	if account.snapshot(account.identity.ServiceID).Known {
		t.Fatal("signing out kept the previous session's directory")
	}
}

// A write that changes who belongs to a network re-reads without being asked.
func TestMembershipWritesRefreshTheDirectory(t *testing.T) {
	fake := &directoryCoordinator{
		networks: []controlplane.Network{{NetworkID: protocol.NewID(), UserID: protocol.NewID(), Name: "mywork", MaxDevices: 10}},
		devices:  map[string][]controlplane.DeviceEntry{},
	}
	_, account, recorder := directoryAccount(t, fake)
	account.rememberToken(strings.Repeat("d", 64))
	if _, err := account.refreshDirectory(context.Background()); err != nil {
		t.Fatal(err)
	}
	<-recorder.seen

	fake.member(fake.networks[0].NetworkID, controlplane.DeviceEntry{DeviceID: protocol.NewID(), Name: "joined"})
	account.refreshAfterWrite()
	select {
	case <-recorder.seen:
	case <-time.After(5 * time.Second):
		t.Fatal("a membership change was not read back")
	}
	if len(account.snapshot(account.identity.ServiceID).Networks[0].Devices) != 1 {
		t.Fatal("the snapshot did not follow the membership change")
	}
}

// A repeated call with the session already known is not a reason to read the
// coordinator again: that would turn every page read into a network round trip.
func TestRepeatedSessionDoesNotRestartTheMaintenance(t *testing.T) {
	_, account, _ := directoryAccount(t, &directoryCoordinator{devices: map[string][]controlplane.DeviceEntry{}})
	if !account.rememberToken(strings.Repeat("e", 64)) {
		t.Fatal("a new session was not recorded")
	}
	if account.rememberToken(strings.Repeat("e", 64)) {
		t.Fatal("the same session was reported as new")
	}
	if account.rememberToken("") {
		t.Fatal("an empty token was recorded as a session")
	}
}
