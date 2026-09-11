//go:build live

// live-drive is a temporary end-to-end driver for the deployed coordinator at
// my.ffkey.com. It exercises the production helper paths (controlplane client,
// peersession manager, runtimebridge tunnel) across two real machines without
// Electron; the coordinator is the shared state between the roles.
//
//	mac fresh    register/login, create network, enroll device A
//	mac pair     create the A->B invite
//	win enroll   login, enroll device B, approve the pair
//	mac confirm  confirm the pair and wait until active
//	win serve    pin the pair and host the local DSH web URL
//	mac connect  connect to B, print the gateway URL, probe the DSH web
//
// State flows mac -> win by shipping state.json; the coordinator records every
// step so each side polls instead of exchanging messages.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

var endpoints = controlplane.Endpoints{
	HTTPSOrigin: "https://my.ffkey.com:8443",
	WSSURL:      "wss://my.ffkey.com:8443/v1/signals",
	STUNAddress: "my.ffkey.com:8443",
}

type deviceState struct {
	Device     controlplane.Device `json:"device"`
	PrivateKey string              `json:"privateKey"`
}

type state struct {
	Email       string      `json:"email"`
	Password    string      `json:"password"`
	NetworkID   string      `json:"networkId"`
	DeviceA     deviceState `json:"deviceA"`
	DeviceB     deviceState `json:"deviceB"`
	PairID      string      `json:"pairId,omitempty"`
	Fingerprint string      `json:"fingerprint,omitempty"`
	RuntimeURL  string      `json:"runtimeUrl,omitempty"`
}

func main() {
	if len(os.Args) != 2 {
		fatal("usage: live-drive mac fresh|adopt|connect | win enroll|serve")
	}
	ctx := context.Background()
	switch os.Args[1] {
	case "mac fresh":
		macFresh(ctx)
	case "mac adopt":
		macAdopt(ctx)
	case "win enroll":
		winEnroll(ctx)
	case "win serve":
		winServe(ctx)
	case "win listen":
		winListen(ctx)
	case "mac connect":
		macConnect(ctx)
	default:
		fatal("unknown step")
	}
}

func baseClient() *controlplane.Client {
	client, err := controlplane.New(endpoints, nil)
	if err != nil {
		fatal("controlplane:", err)
	}
	return client
}

func identity(ctx context.Context, client *controlplane.Client) controlplane.Identity {
	id, err := client.Identity(ctx, nil)
	if err != nil {
		fatal("identity:", err)
	}
	return id
}

func loadState() *state {
	data, err := os.ReadFile(statePath())
	if err != nil {
		fatal("state:", err)
	}
	var s state
	if err = json.Unmarshal(data, &s); err != nil {
		fatal("state decode:", err)
	}
	return &s
}

func storeState(s *state) {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		fatal("state encode:", err)
	}
	if err = os.WriteFile(statePath(), data, 0600); err != nil {
		fatal("state write:", err)
	}
}

func deviceKey(encoded string) ed25519.PrivateKey {
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != ed25519.PrivateKeySize {
		fatal("device key decode:", err)
	}
	return ed25519.PrivateKey(key)
}

func privateKeyEncoded(key ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key)
}

func macFresh(ctx context.Context) {
	email := "live-" + strings.ToLower(protocol.NewID()[:12]) + "@test.local"
	password := protocol.NewID() + strings.ToLower(protocol.NewID()[:16])
	client := baseClient()
	if _, err := client.Register(ctx, email, password); err != nil && !strings.Contains(err.Error(), "user_exists") {
		fatal("register:", err)
	}
	session, err := client.Login(ctx, email, password)
	if err != nil {
		fatal("login:", err)
	}
	network, err := client.CreateNetwork(ctx, session.Token, "mac-win-live")
	if err != nil {
		fatal("create network:", err)
	}
	grant, err := client.EnrollmentToken(ctx, session.Token, network.NetworkID)
	if err != nil {
		fatal("enrollment token:", err)
	}
	key, csr, err := controlplane.NewDeviceKey()
	if err != nil {
		fatal("device key:", err)
	}
	device, err := client.Enroll(ctx, controlplane.Enrollment{RequestID: protocol.NewID(), Token: grant.Token, CSR: csr, Name: "live-mac"})
	if err != nil {
		fatal("enroll A:", err)
	}
	s := &state{Email: email, Password: password, NetworkID: network.NetworkID}
	s.DeviceA = deviceState{Device: device, PrivateKey: privateKeyEncoded(key)}
	storeState(s)
	fmt.Println("A-ENROLLED", device.DeviceID, "network", network.NetworkID)
	fmt.Println("SHIP state.json to windows, then run: live-drive mac pair")
}

func deviceClient(ctx context.Context, device *deviceState) *controlplane.Client {
	client := baseClient()
	authority := identity(ctx, client)
	created, err := client.WithDevice(device.Device, deviceKey(device.PrivateKey), authority)
	if err != nil {
		fatal("device:", err)
	}
	return created
}

func macAdopt(ctx context.Context) {
	s := loadState()
	deviceA := deviceClient(ctx, &s.DeviceA)
	pin := adoptActive(ctx, deviceA, s)
	fmt.Println("PAIR-ACTIVE", pin.Pair.PairID, "initiator", pin.Pair.Initiator, "target", pin.Pair.Target, "revision", pin.Pair.Revision)
	fmt.Println("run on windows: live-drive win serve   (after starting the DSH web)")
}

// adoptActive derives and pins the co-membership pair for the network,
// waiting for the coordinator to expose an active record once the peer
// device has enrolled and adopted on its side.
func adoptActive(ctx context.Context, device *controlplane.Client, s *state) controlplane.PairIdentity {
	timeout := time.Now().Add(3 * time.Minute)
	for {
		// AdoptNetwork derives new co-membership records but does not echo
		// back pairs that already exist, so enumeration goes through the
		// pairs list as well.
		adopted, err := device.AdoptNetwork(ctx)
		if err != nil {
			fatal("adopt:", err)
		}
		listed, err := device.Pairs(ctx)
		if err != nil {
			fatal("pairs:", err)
		}
		all := append(adopted, listed...)
		var peerID string
		if s.DeviceB.Device.DeviceID != "" {
			peerID = s.DeviceB.Device.DeviceID
		}
		for _, pair := range all {
			if pair.NetworkID != s.NetworkID {
				continue
			}
			if peerID != "" && pair.Initiator != peerID && pair.Target != peerID {
				continue
			}
			s.PairID = pair.PairID
			pin, err := device.PairIdentity(ctx, pair.PairID)
			if err == nil && pin.Pair.State == "active" {
				storeState(s)
				return pin
			}
			fmt.Println("DEBUG pair", pair.PairID, pair.NetworkID, pair.Initiator, pair.Target, pair.State, "pinErr", err)
		}
		if time.Now().After(timeout) {
			fatal("pair never became active: enroll B and run win enroll first")
		}
		time.Sleep(2 * time.Second)
	}
}

func winEnroll(ctx context.Context) {
	s := loadState()
	client := baseClient()
	session, err := client.Login(ctx, s.Email, s.Password)
	if err != nil {
		fatal("login B:", err)
	}
	grant, err := client.EnrollmentToken(ctx, session.Token, s.NetworkID)
	if err != nil {
		fatal("enrollment token B:", err)
	}
	key, csr, err := controlplane.NewDeviceKey()
	if err != nil {
		fatal("device key B:", err)
	}
	device, err := client.Enroll(ctx, controlplane.Enrollment{RequestID: protocol.NewID(), Token: grant.Token, CSR: csr, Name: "live-win"})
	if err != nil {
		fatal("enroll B:", err)
	}
	s.DeviceB = deviceState{Device: device, PrivateKey: privateKeyEncoded(key)}
	deviceB := deviceClient(ctx, &s.DeviceB)
	pairs, err := deviceB.AdoptNetwork(ctx)
	if err != nil {
		fatal("adopt B:", err)
	}
	var pairID string
	for _, pair := range pairs {
		if pair.NetworkID == s.NetworkID {
			pairID = pair.PairID
			break
		}
	}
	if pairID == "" {
		fatal("co-membership pair not derived; run mac adopt first")
	}
	s.PairID = pairID
	storeState(s)
	fmt.Println("B-ENROLLED", device.DeviceID, "pair", pairID)
	fmt.Println("run on mac: live-drive mac adopt")
}

func macConfirm(ctx context.Context) {
	s := loadState()
	deviceA := deviceClient(ctx, &s.DeviceA)
	for {
		pin, err := deviceA.PairIdentity(ctx, s.PairID)
		if err == nil && pin.Pair.State == "approved" {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if _, err := deviceA.PairAction(ctx, s.PairID, "confirm", s.Fingerprint); err != nil {
		fatal("confirm:", err)
	}
	for {
		pin, err := deviceA.PairIdentity(ctx, s.PairID)
		if err == nil && (pin.Pair.State == "active" || pin.Pair.State == "revoked") {
			if pin.Pair.State != "active" {
				fatal("pair state:", pin.Pair.State)
			}
			fmt.Println("PAIR-ACTIVE", s.PairID, "initiator", pin.Pair.Initiator, "target", pin.Pair.Target)
			return
		}
		time.Sleep(2 * time.Second)
	}
}

func winServe(ctx context.Context) {
	s := loadState()
	runtimeURL := s.RuntimeURL
	if runtimeURL == "" {
		runtimeURL = "http://127.0.0.1:3080"
		fmt.Println("WARN: state has no runtimeUrl, defaulting to", runtimeURL)
	}
	deviceB := deviceClient(ctx, &s.DeviceB)
	pin, err := deviceB.PairIdentity(ctx, s.PairID)
	if err != nil {
		fatal("pin B:", err)
	}
	if pin.Pair.State != "active" {
		fatal("pair not active yet", pin.Pair.State)
	}
	owner := func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		return runtimebridge.Binding{Generation: 1, URL: runtimeURL}, nil
	}
	manager, err := peersession.New(ctx, deviceB, peersession.Config{Endpoints: endpoints, Authority: identity(ctx, deviceB), Device: s.DeviceB.Device, PrivateKey: deviceKey(s.DeviceB.PrivateKey)}, []controlplane.PairIdentity{pin}, owner, func(state peersession.State) {
		fmt.Println("B-STATE", state.PairID, state.Stage, state.Error, state.Path)
	})
	if err != nil {
		fatal("manager B:", err)
	}
	_ = manager
	fmt.Println("WIN-SERVING", s.DeviceB.Device.DeviceID, "runtime", runtimeURL)
	fmt.Println("run on mac: live-drive mac connect")
	select {}
}

func winListen(ctx context.Context) {
	s := loadState()
	deviceB := deviceClient(ctx, &s.DeviceB)
	signals, err := deviceB.Subscribe(ctx, s.DeviceB.Device.DeviceID)
	if err != nil {
		fatal("subscribe B:", err)
	}
	fmt.Println("WIN-LISTENING", s.DeviceB.Device.DeviceID)
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-signals.Events():
			data, jerr := json.Marshal(event)
			if jerr != nil {
				fmt.Println("B-EVENT encode err:", jerr)
				continue
			}
			fmt.Println("B-EVENT now=", time.Now().Unix(), string(data))
		}
	}
}

func macConnect(ctx context.Context) {
	s := loadState()
	deviceA := deviceClient(ctx, &s.DeviceA)
	pin, err := deviceA.PairIdentity(ctx, s.PairID)
	if err != nil {
		fatal("pin A:", err)
	}
	if pin.Pair.State != "active" {
		fatal("pair not active", pin.Pair.State)
	}
	owner := func(ctx context.Context, pairID string) (runtimebridge.Binding, error) {
		return runtimebridge.Binding{}, errors.New("initiator does not own a runtime")
	}
	manager, err := peersession.New(ctx, deviceA, peersession.Config{Endpoints: endpoints, Authority: identity(ctx, deviceA), Device: s.DeviceA.Device, PrivateKey: deviceKey(s.DeviceA.PrivateKey)}, []controlplane.PairIdentity{pin}, owner, func(state peersession.State) {
		fmt.Println("A-STATE", state.PairID, state.Stage, state.Error, state.Path)
	})
	if err != nil {
		fatal("manager A:", err)
	}
	connected, err := manager.Connect(ctx, s.PairID, 1)
	if err != nil {
		// show the lease timing on failure to diagnose lease_expired
		if le, ok := err.(interface{ Lease() protocol.Lease }); ok {
			lease := le.Lease()
			fmt.Println("A-LEASE-FAIL now=", time.Now().Unix(), "expiresAt=", lease.ExpiresAt, "ttl=", lease.ExpiresAt-time.Now().Unix())
		}
		fatal("connect:", err)
	}
	result := connected.State
	fmt.Println("A-CONNECTED pair", s.PairID, "stage", result.Stage, "generation", result.Generation, "attempt", result.AttemptID)
	fmt.Println("A-PATH", result.Path.Protocol, "local", result.Path.LocalType, "remote", result.Path.RemoteType)
	fmt.Println("A-GATEWAY", connected.URL)
	probe(connected.URL)
	select {}
}

func probe(url string) {
	client := &http.Client{Timeout: 30 * time.Second}
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		fatal("probe request:", err)
	}
	response, err := client.Do(request)
	if err != nil {
		fatal("probe:", err)
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
	response.Body.Close()
	fmt.Println("A-PROBE", response.StatusCode, string(body))
}

func statePath() string {
	return filepath.Join(getenv("LIVE_DIR", "."), "state.json")
}

func fatal(message ...any) {
	fmt.Fprintln(os.Stderr, "live-drive:", message)
	os.Exit(1)
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
