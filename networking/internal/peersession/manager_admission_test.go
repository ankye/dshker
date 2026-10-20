package peersession

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/coder/websocket"
)

func TestScopedPinCatalogCommitIsFencedAndFailureDoesNotPublishPins(t *testing.T) {
	manager, _, _ := controlCandidateManager(t, http.NotFoundHandler())
	_, identity := pinFixture()
	manager.mu.Lock()
	manager.pins = make(map[string]controlplane.PairIdentity)
	manager.mu.Unlock()
	fence, err := manager.CurrentRegistration(identity.Initiator.UserID)
	if err != nil {
		t.Fatal(err)
	}
	committed := false
	err = manager.CommitScopedPins(fence, identity.Initiator.UserID, []controlplane.PairIdentity{identity}, func() error {
		committed = true
		return errors.New("p2p.catalog_conflict")
	})
	if err == nil || err.Error() != "p2p.catalog_conflict" || !committed || len(manager.pins) != 0 {
		t.Fatal("failed durable commit published a live pin", err)
	}
	active := candidateSubscriptionFor(manager.config.CoreInstanceID)
	active.fence.ServerEpoch = fence.ServerEpoch
	manager.signals.mu.Lock()
	manager.signals.active = active
	manager.signals.mu.Unlock()
	t.Cleanup(active.Close)
	committed = false
	err = manager.CommitScopedPins(fence, identity.Initiator.UserID, []controlplane.PairIdentity{identity}, func() error { committed = true; return nil })
	if err == nil || err.Error() != "p2p.registration_stale" || committed || len(manager.pins) != 0 {
		t.Fatal("stale registration reached catalog mutation", err)
	}
}

func TestReadOnlyBootstrapPinsSelectedAccountBeforeCandidateActivation(t *testing.T) {
	_, identity := pinFixture()
	owner := identity.Initiator.UserID
	selected := "ffffffffffff"
	identity.Initiator.Name, identity.Target.Name = "local", "remote"
	identity.Initiator.Presence, identity.Target.Presence = "online", "offline"
	hellos := make(chan protocol.ControlHello, 8)
	var gate sync.Mutex
	var fence protocol.RegistrationFence
	fixture, _, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/signals":
			connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.ControlSubprotocol}})
			if err != nil {
				return
			}
			defer connection.CloseNow()
			_, body, err := connection.Read(r.Context())
			var hello protocol.ControlHello
			if err != nil || protocol.DecodeControl(body, &hello) != nil {
				t.Error("invalid registration")
				return
			}
			hellos <- hello
			current := protocol.RegistrationFence{ServerEpoch: "11111111111111111111111111111111", SubscriptionID: protocol.NewNonce(), CoreInstanceID: hello.CoreInstanceID}
			gate.Lock()
			fence = current
			gate.Unlock()
			body, _ = json.Marshal(protocol.ControlReady{Version: 2, Type: "ready", DeviceID: identity.Initiator.DeviceID, UserID: hello.UserID, Registration: current, Capabilities: []string{protocol.CapabilityCandidate}})
			connection.Write(r.Context(), websocket.MessageText, body)
			for {
				if _, _, err := connection.Read(r.Context()); err != nil {
					return
				}
			}
		case "/v1/heartbeat":
			json.NewEncoder(w).Encode(map[string]any{"deviceId": identity.Initiator.DeviceID, "at": time.Now().Unix()})
		case "/v2/pairs/identity":
			var request protocol.PairIdentityRequest
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				t.Error("malformed scoped identity")
				return
			}
			gate.Lock()
			current := fence
			gate.Unlock()
			if request.Registration != current || request.UserID == owner || request.NetworkID != identity.Pair.NetworkID || request.PairID != identity.Pair.PairID {
				t.Error("identity request borrowed enrolled-owner or target-id scope")
			}
			result := identity
			result.Initiator.UserID, result.Target.UserID = request.UserID, request.UserID
			json.NewEncoder(w).Encode(result)
		default:
			t.Errorf("bootstrap used unapproved endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	fixture.client.SetAccount(selected)
	config := fixture.config
	config.Device.UserID = owner
	noop := func(context.Context, string) (runtimebridge.Binding, error) {
		t.Error("bootstrap requested DSH")
		return runtimebridge.Binding{}, nil
	}
	if _, err := New(fixture.ctx, fixture.client, config, []controlplane.PairIdentity{identity}, noop, func(State) {}); err == nil || err.Error() != "p2p.invalid_request" {
		t.Fatal("cached initial pins admitted", err)
	}
	manager, err := New(fixture.ctx, fixture.client, config, []controlplane.PairIdentity{}, noop, func(State) {})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	first := <-hellos
	if first.Capabilities == nil || len(first.Capabilities) != 0 || first.UserID != selected {
		t.Fatal("new manager advertised before fresh pins", first)
	}
	if _, err := manager.Connect(fixture.ctx, identity.Target.DeviceID, 1, true); err == nil || err.Error() != "p2p.candidate_unsupported" {
		t.Fatal("read-only owner could prepare", err)
	}
	fresh, err := manager.PinScopedIdentity(fixture.ctx, selected, identity.Pair.NetworkID, identity.Pair.PairID)
	if err != nil {
		t.Fatal(err)
	}
	pin := manager.pins[identity.Target.DeviceID]
	if fresh.Pair.PairID != identity.Pair.PairID || pin.Pair.PairID != identity.Target.DeviceID || pin.Initiator.UserID != selected || pin.Target.UserID != selected || manager.config.Device.UserID != owner {
		t.Fatal("scope projection changed enrolled identity or confused row/target ids")
	}
	if err := manager.ActivateCandidates(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	active := <-hellos
	if !protocol.HasCapability(active.Capabilities, protocol.CapabilityCandidate) || active.CoreInstanceID != first.CoreInstanceID {
		t.Fatal("activation changed core or omitted capability", active)
	}
	if err := manager.SetAccount(fixture.ctx, "999999999999"); err != nil {
		t.Fatal(err)
	}
	changed := <-hellos
	if changed.Capabilities == nil || len(changed.Capabilities) != 0 || changed.CoreInstanceID != first.CoreInstanceID || len(manager.pins) != 0 || manager.candidatesActive {
		t.Fatal("account change bypassed read-only bootstrap", changed)
	}
}

func TestFreshIdentityLateReplyCannotPinNewRegistrationOrAccount(t *testing.T) {
	for _, kind := range []string{"registration", "account"} {
		t.Run(kind, func(t *testing.T) {
			_, identity := pinFixture()
			entered, release := make(chan struct{}), make(chan struct{})
			manager, _, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v2/pairs/identity" {
					t.Error("scoped read used another route")
					return
				}
				close(entered)
				<-release
				json.NewEncoder(w).Encode(identity)
			}))
			manager.pins = make(map[string]controlplane.PairIdentity)
			result := make(chan error, 1)
			go func() {
				_, err := manager.PinScopedIdentity(manager.ctx, identity.Initiator.UserID, identity.Pair.NetworkID, identity.Pair.PairID)
				result <- err
			}()
			<-entered
			manager.mu.Lock()
			if kind == "registration" {
				next := candidateSubscriptionFor(manager.config.CoreInstanceID)
				t.Cleanup(next.Close)
				manager.signals.mu.Lock()
				manager.signals.active = next
				manager.signals.mu.Unlock()
			} else {
				manager.accountUserID = "ffffffffffff"
				manager.client.SetAccount(manager.accountUserID)
			}
			manager.mu.Unlock()
			close(release)
			if err := <-result; err == nil {
				t.Fatal("late identity reply granted live pin authority")
			}
			if len(manager.pins) != 0 {
				t.Fatal("rejected identity reply wrote a pin")
			}
		})
	}
}

func TestScopedPendingPairReadNeverGrantsLivePin(t *testing.T) {
	for _, state := range []string{"invited", "approved"} {
		t.Run(state, func(t *testing.T) {
			_, identity := pinFixture()
			identity.Pair.State, identity.Pair.ExpiresAt = state, time.Now().Add(time.Minute).Unix()
			manager, _, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(identity) }))
			manager.pins = make(map[string]controlplane.PairIdentity)
			read, err := manager.ScopedPairIdentity(manager.ctx, identity.Initiator.UserID, identity.Pair.NetworkID, identity.Pair.PairID)
			if err != nil || read.Pair.State != state {
				t.Fatal("nonexpired pending state was erased from read", read, err)
			}
			if _, err := manager.PinScopedIdentity(manager.ctx, identity.Initiator.UserID, identity.Pair.NetworkID, identity.Pair.PairID); err == nil || err.Error() != "p2p.pair_unauthorized" {
				t.Fatal("pending read granted live pin", err)
			}
			if len(manager.pins) != 0 {
				t.Fatal("pending pair reached live authorization")
			}
		})
	}
}
