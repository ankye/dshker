package core

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/ankye/dshker/networking/internal/remoteroute"
)

// remoteConnector builds one connector whose seams never touch OpenSSH, so the
// channel can be driven without a second machine.
func remoteConnector(t *testing.T, failWith error) (*remoteroute.Route, *int) {
	t.Helper()
	directory := t.TempDir()
	stops := 0
	connector := remoteroute.Connector{
		Executables: remoteroute.Executables{SSH: "/usr/bin/ssh", SCP: "/usr/bin/scp"},
		RunSCP: func(_ context.Context, _ string, args []string) error {
			if failWith != nil {
				return failWith
			}
			return os.WriteFile(args[len(args)-1], []byte(
				`{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":3088,"secret":"s3cret"}`), 0o600)
		},
		SpawnTunnel: func(string, []string) (remoteroute.Tunnel, error) {
			return &fakeRemoteTunnel{exited: make(chan struct{}), onStop: func() { stops++ }}, nil
		},
		WaitForward: func(context.Context, remoteroute.Tunnel, int) error { return nil },
		ReservePort: func() (int, error) { return 51000, nil },
		RequestRuntime: func(context.Context, int, string) (string, error) {
			return "http://127.0.0.1:3088/?token=abc", nil
		},
		TemporaryDirectory: func() (string, error) { return directory, nil },
		RemoveAll:          func(string) error { return nil },
	}
	return &remoteroute.Route{Connector: connector}, &stops
}

type fakeRemoteTunnel struct {
	exited chan struct{}
	onStop func()
	once   sync.Once
}

func (tunnel *fakeRemoteTunnel) Exited() <-chan struct{} { return tunnel.exited }

func (tunnel *fakeRemoteTunnel) Stderr() string { return "" }

func (tunnel *fakeRemoteTunnel) Stop() error {
	tunnel.once.Do(func() {
		if tunnel.onStop != nil {
			tunnel.onStop()
		}
	})
	return nil
}

func remotePayload(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// TestRemoteMethodsNeedARoute keeps the refusal honest: a core built without the
// SSH route does not pretend a connection exists.
func TestRemoteMethodsNeedARoute(t *testing.T) {
	payloads := map[string]string{
		"remote.connect":    `{"connectionId":"connection_main","computer":{"host":"build.example","port":22,"user":"deploy","sshKeyPath":""},"ssh":"","scp":"","sshKeyPath":""}`,
		"remote.disconnect": `{"connectionId":"connection_main"}`,
		"remote.status":     `{"connectionId":"connection_main"}`,
	}
	for method, payload := range payloads {
		if _, err := Handle(context.Background(), method, json.RawMessage(payload)); err == nil || err.Error() != "p2p.not_implemented" {
			t.Errorf("Handle(%q) = %v", method, err)
		}
	}
}

// TestRemoteConnectAndDisconnectThroughTheCore drives the route over the private
// channel and asserts the URL, the idempotence of the record, and the refusal for
// an id that was never opened.
func TestRemoteConnectAndDisconnectThroughTheCore(t *testing.T) {
	route, stops := remoteConnector(t, nil)
	server := Serve{Remote: route}
	ctx := context.Background()
	connected, err := server.Handle(ctx, "remote.connect", remotePayload(t, struct {
		ConnectionID string               `json:"connectionId"`
		Computer     remoteroute.Computer `json:"computer"`
		SSH          string               `json:"ssh"`
		SCP          string               `json:"scp"`
		SSHKeyPath   string               `json:"sshKeyPath"`
	}{"connection_main", remoteroute.Computer{Host: "build.example", Port: 22, User: "deploy", SSHKeyPath: ""}, "", "", ""}))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	result, ok := connected.(remoteResult)
	if !ok || result.URL != "http://127.0.0.1:51000/?token=abc" {
		t.Fatalf("connect = %+v", connected)
	}
	status, err := server.Handle(ctx, "remote.status", json.RawMessage(`{"connectionId":"connection_main"}`))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if view, ok := status.(remoteStatusResult); !ok || !view.Present || view.URL != result.URL {
		t.Fatalf("status = %+v", status)
	}
	if _, err := server.Handle(ctx, "remote.disconnect", json.RawMessage(`{"connectionId":"connection_main"}`)); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if *stops == 0 {
		t.Fatal("disconnect left a forward running")
	}
	if _, err := server.Handle(ctx, "remote.disconnect", json.RawMessage(`{"connectionId":"connection_main"}`)); !errors.Is(err, remoteroute.ErrNotConnected) {
		t.Fatalf("second disconnect = %v", err)
	}
	// A subject that never connected reports nothing rather than failing.
	absent, err := server.Handle(ctx, "remote.status", json.RawMessage(`{"connectionId":"connection_absent"}`))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if view, ok := absent.(remoteStatusResult); !ok || view.Present {
		t.Fatalf("absent status = %+v", absent)
	}
}

// TestRemoteConnectCarriesItsRefusal pins the code the renderer already maps.
func TestRemoteConnectCarriesItsRefusal(t *testing.T) {
	route, _ := remoteConnector(t, remoteroute.ErrAuthenticationFailed)
	server := Serve{Remote: route}
	_, err := server.Handle(context.Background(), "remote.connect", remotePayload(t, struct {
		ConnectionID string               `json:"connectionId"`
		Computer     remoteroute.Computer `json:"computer"`
		SSH          string               `json:"ssh"`
		SCP          string               `json:"scp"`
		SSHKeyPath   string               `json:"sshKeyPath"`
	}{"connection_main", remoteroute.Computer{Host: "build.example", Port: 22, User: "deploy", SSHKeyPath: ""}, "", "", ""}))
	if !errors.Is(err, remoteroute.ErrAuthenticationFailed) {
		t.Fatalf("connect = %v", err)
	}
}

func TestRemoteRejectsMalformedPayloads(t *testing.T) {
	route, _ := remoteConnector(t, nil)
	server := Serve{Remote: route}
	for name, payload := range map[string]string{
		"a missing field":  `{"connectionId":"connection_main"}`,
		"an unknown field": `{"connectionId":"connection_main","computer":{"host":"h","port":22,"user":"u"},"ssh":"","scp":"","extra":1}`,
		"not an object":    "[]",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := server.Handle(context.Background(), "remote.connect", json.RawMessage(payload)); err == nil {
				t.Fatalf("%s was accepted", payload)
			}
		})
	}
}
