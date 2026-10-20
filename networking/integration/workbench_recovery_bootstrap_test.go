//go:build live

package integration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
	"testing"
	"testing/synctest"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Pure contract inputs only: no DSH, provider, coordinator, socket or timer is
// started. Keys and the CA are genuinely generated, never production fixtures.
func recoveryBootstrapFixture(t *testing.T) (*fixture, recoveryCatalogView) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	certificate, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	must(t, err)
	keyID := sha256.Sum256(public)
	f := &fixture{ctx: context.Background(), authority: controlplane.Identity{ServiceID: hex.EncodeToString(keyID[:6]), PublicKey: public, Certificate: certificate}, endpoints: controlplane.Endpoints{HTTPSOrigin: "https://127.0.0.1:8443", WSSURL: "wss://127.0.0.1:8443/v1/signals", STUNAddress: "127.0.0.1:3478"}}
	f.userSession = controlplane.UserSession{User: controlplane.User{UserID: protocol.NewID(), Username: "bootstrap@test.local"}, Token: protocol.NewNonce() + protocol.NewNonce(), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	for index := range 2 {
		key, _, err := ed25519.GenerateKey(rand.Reader)
		must(t, err)
		f.config[index].Device = controlplane.Device{DeviceID: protocol.NewID(), UserID: f.userSession.User.UserID, Name: "bootstrap-device", PublicKey: key}
	}
	local, remote := f.config[0].Device, f.config[1].Device
	f.config[0].Pin = controlplane.PairIdentity{
		Pair:      controlplane.Pair{PairID: protocol.NewID(), NetworkID: protocol.NewID(), Initiator: local.DeviceID, Target: remote.DeviceID, State: "active", Revision: 1},
		Initiator: controlplane.PairDeviceIdentity{DeviceID: local.DeviceID, UserID: f.userSession.User.UserID, PublicKey: local.PublicKey},
		Target:    controlplane.PairDeviceIdentity{DeviceID: remote.DeviceID, UserID: f.userSession.User.UserID, PublicKey: remote.PublicKey},
	}
	view := recoveryCatalogView{Enabled: true, Record: catalog.Record{Format: "dshker.p2p-devices", Version: 1, CatalogID: protocol.NewID(), Services: []catalog.Service{integrationCatalogService(f)}, Computers: []catalog.Computer{{
		ConnectionID: remote.DeviceID, ServiceID: f.authority.ServiceID, DisplayName: remote.Name, PairID: remote.DeviceID,
		NetworkID: f.config[0].Pin.Pair.NetworkID, LocalDeviceID: local.DeviceID, RemoteDeviceID: remote.DeviceID, UserID: f.userSession.User.UserID,
		LocalPublicKey: base64.StdEncoding.EncodeToString(local.PublicKey), RemotePublicKey: base64.StdEncoding.EncodeToString(remote.PublicKey), PairRevision: 1, PairState: "active",
	}}, ForgottenServiceIDs: []string{}}}
	data, err := json.Marshal(view.Record)
	must(t, err)
	digest := sha256.Sum256(data)
	view.Revision = hex.EncodeToString(digest[:])
	return f, view
}

func TestRecoveryBootstrapCatalogReadbackNeverEnablesOrCommits(t *testing.T) {
	f, view := recoveryBootstrapFixture(t)
	store, err := catalog.Open(t.TempDir())
	must(t, err)
	first, err := store.Enable()
	must(t, err)
	view.Record.CatalogID = first.Record.CatalogID
	before, err := store.Commit(first.Revision, view.Record)
	must(t, err)
	server := core.Serve{Catalog: store}
	var methods []string
	call := func(ctx context.Context, method string, payload any) (json.RawMessage, error) {
		methods = append(methods, method)
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		result, err := server.Handle(ctx, method, data)
		if err != nil {
			return nil, err
		}
		return json.Marshal(result)
	}
	must(t, recoveryReadInitialIntent(f.ctx, call, f))
	after, err := store.Inspect()
	must(t, err)
	if !reflect.DeepEqual(methods, []string{"core.catalog_inspect"}) || after == nil || !reflect.DeepEqual(before, *after) {
		t.Fatal("readback repeated Enable/Commit or changed the production catalog")
	}
	if _, err := store.Enable(); !errors.Is(err, catalog.ErrExists) {
		t.Fatal("production duplicate Enable refusal was weakened", err)
	}
}

func TestRecoveryBootstrapCatalogRejectsForeignAndIncompleteScope(t *testing.T) {
	for _, name := range []string{"null", "malformed", "disabled", "revision", "service", "account", "network", "local-key", "remote-key", "pin", "missing-computer", "expired-session"} {
		t.Run(name, func(t *testing.T) {
			f, view := recoveryBootstrapFixture(t)
			switch name {
			case "disabled":
				view.Enabled = false
			case "revision":
				view.Revision = "not-a-revision"
			case "service":
				view.Record.Services[0].ServiceID = protocol.NewID()
			case "account":
				view.Record.Computers[0].UserID = protocol.NewID()
			case "network":
				view.Record.Computers[0].NetworkID = protocol.NewID()
			case "local-key":
				view.Record.Computers[0].LocalPublicKey = ""
			case "remote-key":
				view.Record.Computers[0].RemotePublicKey = ""
			case "pin":
				view.Record.Computers[0].PairRevision++
			case "missing-computer":
				view.Record.Computers = nil
			case "expired-session":
				f.userSession.ExpiresAt = time.Now().Unix()
			}
			calls := 0
			call := func(context.Context, string, any) (json.RawMessage, error) {
				calls++
				if name == "null" {
					return json.RawMessage(`null`), nil
				}
				if name == "malformed" {
					return json.RawMessage(`{"enabled":`), nil
				}
				return json.Marshal(view)
			}
			if recoveryReadInitialIntent(f.ctx, call, f) == nil || calls != 1 {
				t.Fatal("unverified catalog/session was accepted or retried")
			}
		})
	}
}

type recoveryBootstrapWire struct {
	f       *fixture
	view    recoveryCatalogView
	owner   *recoveryBootstrapOwner
	methods []string
	opened  peersession.Connected
	hook    func(string, *recoveryBootstrapWire)
}

func recoveryBootstrapTestWire(t *testing.T) *recoveryBootstrapWire {
	f, view := recoveryBootstrapFixture(t)
	peer := new(localrpc.Peer) // Pure pointer identity, never used for IO.
	owner := &recoveryBootstrapOwner{peer: peer, pair: f.config[1].Device.DeviceID, changed: make(chan struct{})}
	owner.observe(peersession.State{PairID: owner.pair, AttemptID: protocol.NewNonce(), Generation: 25_230_000_000, Stage: "connected"})
	return &recoveryBootstrapWire{f: f, view: view, owner: owner}
}

func (wire *recoveryBootstrapWire) call(_ context.Context, method string, payload any) (json.RawMessage, error) {
	wire.methods = append(wire.methods, method)
	if wire.hook != nil {
		wire.hook(method, wire)
	}
	switch method {
	case "core.catalog_inspect":
		return json.Marshal(wire.view)
	case "peer.connect":
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		var request struct {
			ServiceID string `json:"serviceId"`
			Data      struct {
				PairID           string `json:"pairId"`
				Generation       uint64 `json:"generation"`
				RequestWorkbench bool   `json:"requestWorkbench"`
			} `json:"data"`
		}
		if protocol.DecodeExact(data, &request) != nil || request.ServiceID != wire.f.authority.ServiceID || request.Data.PairID != wire.owner.pair || !request.Data.RequestWorkbench || request.Data.Generation <= wire.owner.current.Generation {
			return nil, errors.New("test.invalid_explicit_open")
		}
		wire.opened = peersession.Connected{State: peersession.State{PairID: wire.owner.pair, AttemptID: protocol.NewNonce(), Generation: request.Data.Generation, Stage: "ready", RuntimeGeneration: 1}, URL: "http://127.0.0.1:34567/"}
		wire.owner.observe(wire.opened.State)
		return json.Marshal(wire.opened)
	case "peer.entry":
		return json.Marshal(struct {
			ServiceID string            `json:"serviceId"`
			State     peersession.State `json:"state"`
			URL       string            `json:"url"`
		}{wire.f.authority.ServiceID, wire.opened.State, wire.opened.URL})
	}
	return nil, errors.New("test.unexpected_bootstrap_method")
}

func TestRecoveryBootstrapServeOpensExactlyOnceAfterCompletedTransport(t *testing.T) {
	wire := recoveryBootstrapTestWire(t)
	initial := wire.owner.current
	first, err := recoveryInitialBusinessOpen(wire.f.ctx, wire.owner.peer, wire.call, wire.f, wire.owner)
	must(t, err)
	if first.State.Generation != initial.Generation+1 || first.State.AttemptID == initial.AttemptID || !reflect.DeepEqual(wire.methods, []string{"core.catalog_inspect", "peer.connect", "peer.entry"}) {
		t.Fatal("initial handoff repeated/skipped an open or missed exact entry readback")
	}
}

func TestRecoveryBootstrapWaitRequiresActualCompletedEvent(t *testing.T) {
	wire := recoveryBootstrapTestWire(t)
	completed := wire.owner.current
	wire.owner.current.Stage = "punching"
	ctx, cancel := context.WithCancel(wire.f.ctx)
	defer cancel()
	type result struct {
		state peersession.State
		err   error
	}
	done := make(chan result, 1)
	go func() { state, err := wire.owner.wait(ctx, wire.owner.peer); done <- result{state, err} }()
	select {
	case <-done:
		t.Fatal("unfinished candidate was treated as completed transport")
	default:
	}
	wire.owner.observe(completed)
	actual := <-done
	if actual.err != nil || actual.state != completed || len(wire.methods) != 0 {
		t.Fatal("completion observation dialed/reconciled or lost the exact transport", actual.err)
	}
}

func TestRecoveryBootstrapGenerationRejectsUnfinishedAndOverflow(t *testing.T) {
	for _, name := range []string{"zero", "attempt", "pair", "punching", "ready", "refusal", "runtime", "overflow", "wrapped"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			state := wire.owner.current
			switch name {
			case "zero":
				state.Generation = 0
			case "attempt":
				state.AttemptID = "bad"
			case "pair":
				state.PairID = protocol.NewID()
			case "punching":
				state.Stage = "punching"
			case "ready":
				state.Stage = "ready"
			case "refusal":
				state.Error = "p2p.runtime_unavailable"
			case "runtime":
				state.RuntimeGeneration = 1
			case "overflow":
				state.Generation = 1<<53 - 1
			case "wrapped":
				state.Generation = ^uint64(0)
			}
			if next, err := recoveryInitialGeneration(state, wire.owner.pair); err == nil || next != 0 {
				t.Fatal("unfinished/foreign/overflow owner gained a generation")
			}
		})
	}
}

func TestRecoveryBootstrapRefusesLateReplacedAndCancelledOwners(t *testing.T) {
	for _, name := range []string{"missing", "foreign-peer", "cancelled", "unfinished", "replacement-before-open", "replacement-after-open", "replacement-after-entry", "late-open", "late-entry", "stale-event"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			ctx, cancel := context.WithCancel(wire.f.ctx)
			defer cancel()
			peer, owner := wire.owner.peer, wire.owner
			switch name {
			case "missing":
				owner = nil
			case "foreign-peer":
				peer = new(localrpc.Peer)
			case "cancelled":
				cancel()
			case "unfinished":
				wire.owner.current.Stage = "punching"
				cancel()
			case "stale-event":
				state := wire.owner.current
				state.Generation--
				wire.owner.observe(state)
			}
			wire.hook = func(method string, w *recoveryBootstrapWire) {
				if name == "replacement-before-open" && method == "core.catalog_inspect" || name == "replacement-after-entry" && method == "peer.entry" {
					w.owner.observe(peersession.State{PairID: w.owner.pair, AttemptID: protocol.NewNonce(), Generation: w.owner.current.Generation + 1, Stage: "connected"})
				}
				if name == "replacement-after-open" && method == "peer.connect" {
					w.owner.peer = new(localrpc.Peer)
				}
				if name == "late-open" && method == "peer.connect" || name == "late-entry" && method == "peer.entry" {
					cancel()
				}
			}
			if _, err := recoveryInitialBusinessOpen(ctx, peer, wire.call, wire.f, owner); err == nil {
				t.Fatal("missing/late/replaced owner accepted an initial business open")
			}
			opens := 0
			for _, method := range wire.methods {
				if method == "peer.connect" {
					opens++
				}
			}
			if opens > 1 || (name == "missing" || name == "foreign-peer" || name == "cancelled" || name == "unfinished" || name == "replacement-before-open" || name == "stale-event") && opens != 0 {
				t.Fatal("refused owner dispatched or retried a business open", wire.methods)
			}
		})
	}
}

func TestRecoveryBootstrapBusinessAndEntryFailuresNeverRetry(t *testing.T) {
	for _, name := range []string{"open-null", "open-malformed", "open-foreign-pair", "open-generation", "open-attempt", "open-connected", "stale", "busy", "entry-null", "entry-service", "entry-attempt", "entry-url", "entry-extra"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			call := func(ctx context.Context, method string, payload any) (json.RawMessage, error) {
				raw, err := wire.call(ctx, method, payload)
				if err != nil {
					return nil, err
				}
				if method == "peer.connect" {
					switch name {
					case "open-null":
						return json.RawMessage(`null`), nil
					case "open-malformed":
						return json.RawMessage(`{"state":`), nil
					case "stale":
						return nil, errors.New("p2p.stale_generation")
					case "busy":
						return nil, errors.New("p2p.connection_busy")
					}
					opened := wire.opened
					switch name {
					case "open-foreign-pair":
						opened.State.PairID = protocol.NewID()
					case "open-generation":
						opened.State.Generation++
					case "open-attempt":
						opened.State.AttemptID = ""
					case "open-connected":
						opened.State.Stage = "connected"
					}
					return json.Marshal(opened)
				}
				if method == "peer.entry" {
					if name == "entry-null" {
						return json.RawMessage(`null`), nil
					}
					var entry map[string]json.RawMessage
					must(t, json.Unmarshal(raw, &entry))
					switch name {
					case "entry-service":
						entry["serviceId"], err = json.Marshal(protocol.NewID())
					case "entry-attempt":
						state := wire.opened.State
						state.AttemptID = protocol.NewNonce()
						entry["state"], err = json.Marshal(state)
					case "entry-url":
						entry["url"], err = json.Marshal("http://127.0.0.1:34568/")
					case "entry-extra":
						entry["unexpected"] = json.RawMessage(`true`)
					}
					must(t, err)
					return json.Marshal(entry)
				}
				return raw, nil
			}
			if _, err := recoveryInitialBusinessOpen(wire.f.ctx, wire.owner.peer, call, wire.f, wire.owner); err == nil {
				t.Fatal("invalid or refused business/entry response was accepted")
			}
			opens := 0
			for _, method := range wire.methods {
				if method == "peer.connect" {
					opens++
				}
			}
			if opens != 1 {
				t.Fatal("business open was retried", wire.methods)
			}
		})
	}
}

func TestRecoveryBootstrapCrossPhaseRoutesThroughSharedBarrier(t *testing.T) {
	for _, phase := range []string{"forward-stress", "duplex", "network-fault", "program-pause", "core-crash"} {
		t.Run(phase, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				wire := recoveryBootstrapTestWire(t)
				completed := wire.owner.current
				wire.owner.current.Stage = "punching"
				reverses := 0
				var reverse func() error
				if phase != "forward-stress" {
					reverse = func() error { reverses++; wire.methods = append(wire.methods, "reverse-open"); return nil }
				}
				type result struct {
					first peersession.Connected
					err   error
				}
				done := make(chan result, 1)
				go func() {
					first, err := recoveryInitializeCross(wire.f.ctx, wire.owner.peer, wire.call, wire.f, wire.owner, phase, reverse)
					done <- result{first, err}
				}()
				// Wait advances no wall-clock sleep: the real shared router is now
				// durably blocked on this owner's actual completion notification.
				synctest.Wait()
				if len(wire.methods) != 0 || reverses != 0 {
					t.Fatal("phase bypassed unfinished automatic owner", wire.methods)
				}
				select {
				case <-done:
					t.Fatal("phase returned before transport completion")
				default:
				}
				wire.owner.observe(completed)
				synctest.Wait()
				actual := <-done
				must(t, actual.err)
				expected := []string{"core.catalog_inspect"}
				if phase != "core-crash" {
					expected = append(expected, "peer.connect", "peer.entry")
					if actual.first.State.Stage != "ready" || actual.first.State.Generation != completed.Generation+1 {
						t.Fatal("business handoff lost its newer ready owner")
					}
				} else if actual.first != (peersession.Connected{}) {
					t.Fatal("core-crash invented Windows business intent")
				}
				if phase != "forward-stress" {
					expected = append(expected, "reverse-open")
				}
				if !reflect.DeepEqual(wire.methods, expected) || phase != "forward-stress" && reverses != 1 {
					t.Fatal("phase changed explicit-open/entry/reverse cardinality or order", wire.methods)
				}
			})
		})
	}
}

func TestRecoveryBootstrapCoreCrashRefusesInvalidBarrierBeforeReverse(t *testing.T) {
	for _, name := range []string{"catalog", "replaced", "cancelled", "missing-owner"} {
		t.Run(name, func(t *testing.T) {
			wire := recoveryBootstrapTestWire(t)
			ctx, cancel := context.WithCancel(wire.f.ctx)
			defer cancel()
			owner := wire.owner
			switch name {
			case "catalog":
				wire.view.Record.Computers[0].UserID = protocol.NewID()
			case "replaced":
				wire.hook = func(method string, w *recoveryBootstrapWire) {
					if method == "core.catalog_inspect" {
						w.owner.peer = new(localrpc.Peer)
					}
				}
			case "cancelled":
				cancel()
			case "missing-owner":
				owner = nil
			}
			reverses := 0
			_, err := recoveryInitializeCross(ctx, wire.owner.peer, wire.call, wire.f, owner, "core-crash", func() error { reverses++; return nil })
			if err == nil || reverses != 0 {
				t.Fatal("unverified core-crash owner reached reverse-open")
			}
			for _, method := range wire.methods {
				if method != "core.catalog_inspect" {
					t.Fatal("core-crash dispatched a Windows business open or entry", wire.methods)
				}
			}
		})
	}
}
