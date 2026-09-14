package remoteroute

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTunnel is one forwarding process the test controls.
type fakeTunnel struct {
	exited chan struct{}
	stderr string
	stops  int
	mutex  sync.Mutex
}

func (tunnel *fakeTunnel) Exited() <-chan struct{} { return tunnel.exited }

func (tunnel *fakeTunnel) Stderr() string { return tunnel.stderr }

func (tunnel *fakeTunnel) Stop() error {
	tunnel.mutex.Lock()
	defer tunnel.mutex.Unlock()
	tunnel.stops++
	return nil
}

func (tunnel *fakeTunnel) stopCount() int {
	tunnel.mutex.Lock()
	defer tunnel.mutex.Unlock()
	return tunnel.stops
}

// connectorBrokerRequests records the broker ports the last helper observed.
var connectorBrokerRequests *[]int

const descriptorDocument = `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":3088,"secret":"s3cret"}`

// generation builds one connector whose seams the test drives.
func newGeneration(t *testing.T, override func(*Connector)) (*Connector, *[]*fakeTunnel, *[]string) {
	t.Helper()
	directory := t.TempDir()
	ports := []int{51000, 52000}
	reserved := 0
	tunnels := &[]*fakeTunnel{}
	spawned := &[]string{}
	brokerRequests := []int{}
	connector := Connector{
		Executables: Executables{SSH: "/usr/bin/ssh", SCP: "/usr/bin/scp"},
		RunSCP: func(_ context.Context, executable string, args []string) error {
			if executable != "/usr/bin/scp" || args[0] != "-q" {
				t.Errorf("scp invocation = %s %v", executable, args)
			}
			return os.WriteFile(args[len(args)-1], []byte(descriptorDocument), 0o600)
		},
		SpawnTunnel: func(executable string, args []string) (Tunnel, error) {
			*spawned = append(*spawned, executable+" "+strings.Join(args, " "))
			tunnel := &fakeTunnel{exited: make(chan struct{})}
			*tunnels = append(*tunnels, tunnel)
			return tunnel, nil
		},
		WaitForward: func(context.Context, Tunnel, int) error { return nil },
		ReservePort: func() (int, error) {
			port := ports[reserved]
			reserved++
			return port, nil
		},
		RequestRuntime: func(_ context.Context, port int, secret string) (string, error) {
			brokerRequests = append(brokerRequests, port)
			if secret != "s3cret" {
				t.Errorf("broker secret = %q", secret)
			}
			// The seam returns the accepted URL, which is what the production request
			// extracts from the broker body.
			return "http://127.0.0.1:3088/?token=abc", nil
		},
		TemporaryDirectory: func() (string, error) { return directory, nil },
		RemoveAll:          func(string) error { return nil },
	}
	if override != nil {
		override(&connector)
	}
	connectorBrokerRequests = &brokerRequests
	return &connector, tunnels, spawned
}

// TestConnectRunsOneGeneration drives the whole route: descriptor transfer, the
// broker forward, the broker call, the runtime forward, and the mapping of the
// accepted URL onto the local forward that carries it.
func TestConnectRunsOneGeneration(t *testing.T) {
	connector, tunnels, spawned := newGeneration(t, nil)
	url, stop, err := (*connector).Connect(context.Background(), computer(), func() {})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if url != "http://127.0.0.1:52000/?token=abc" {
		t.Fatalf("url = %q", url)
	}
	if len(*spawned) != 2 {
		t.Fatalf("spawned = %v", *spawned)
	}
	if len(*connectorBrokerRequests) != 1 || (*connectorBrokerRequests)[0] != 51000 {
		t.Fatalf("broker requests = %v", *connectorBrokerRequests)
	}
	if !strings.Contains((*spawned)[0], "127.0.0.1:51000:127.0.0.1:3088") ||
		!strings.Contains((*spawned)[1], "127.0.0.1:52000:127.0.0.1:3088") {
		t.Fatalf("forwards = %v", *spawned)
	}
	stop()
	for _, tunnel := range *tunnels {
		if tunnel.stopCount() == 0 {
			t.Fatal("a forward was left running")
		}
	}
}

// TestConnectReportsEachFailureAsItsOwnCode keeps the classifications apart, so
// an authentication problem is never reported as a missing peer.
func TestConnectReportsEachFailureAsItsOwnCode(t *testing.T) {
	cases := map[string]struct {
		override func(*Connector)
		expected error
	}{
		"an authentication refusal": {
			override: func(connector *Connector) {
				connector.RunSCP = func(context.Context, string, []string) error {
					return ErrAuthenticationFailed
				}
			},
			expected: ErrAuthenticationFailed,
		},
		"an unavailable peer": {
			override: func(connector *Connector) {
				connector.RunSCP = func(context.Context, string, []string) error { return ErrPeerUnavailable }
			},
			expected: ErrPeerUnavailable,
		},
		"a malformed descriptor": {
			override: func(connector *Connector) {
				connector.RunSCP = func(_ context.Context, _ string, args []string) error {
					return os.WriteFile(args[len(args)-1], []byte("{}"), 0o600)
				}
			},
			expected: ErrPeerProtocolInvalid,
		},
		"a refused forward": {
			override: func(connector *Connector) {
				connector.WaitForward = func(context.Context, Tunnel, int) error { return ErrTunnelFailed }
			},
			expected: ErrTunnelFailed,
		},
		"a rejected bearer": {
			override: func(connector *Connector) {
				connector.RequestRuntime = func(context.Context, int, string) (string, error) {
					return "", ErrPeerAuthentication
				}
			},
			expected: ErrPeerAuthentication,
		},
		"an invalid broker answer": {
			override: func(connector *Connector) {
				connector.RequestRuntime = func(context.Context, int, string) (string, error) {
					return "", ErrPeerProtocolInvalid
				}
			},
			expected: ErrPeerProtocolInvalid,
		},
		"a non loopback answer": {
			override: func(connector *Connector) {
				connector.RequestRuntime = func(context.Context, int, string) (string, error) {
					return "http://192.168.1.9:3088/", nil
				}
			},
			expected: ErrPeerProtocolInvalid,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			connector, tunnels, _ := newGeneration(t, testCase.override)
			_, _, err := (*connector).Connect(context.Background(), computer(), func() {})
			if !errors.Is(err, testCase.expected) {
				t.Fatalf("%s = %v", name, err)
			}
			for _, tunnel := range *tunnels {
				if tunnel.stopCount() == 0 {
					t.Fatal("a refused generation left a forward running")
				}
			}
		})
	}
}

// TestUnexpectedExitRetiresTheGeneration covers the callback the shell used to
// learn that a forward died after the address had been handed out.
func TestUnexpectedExitRetiresTheGeneration(t *testing.T) {
	connector, tunnels, _ := newGeneration(t, nil)
	retired := make(chan struct{}, 1)
	_, stop, err := (*connector).Connect(context.Background(), computer(), func() {
		retired <- struct{}{}
	})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer stop()
	close((*tunnels)[1].exited)
	select {
	case <-retired:
	case <-time.After(5 * time.Second):
		t.Fatal("a dead forward did not retire the generation")
	}
}

// TestTemporaryDirectoryIsPrivate pins the descriptor intake directory.
func TestTemporaryDirectoryIsPrivate(t *testing.T) {
	directory, err := temporaryDirectory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(directory) }()
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	if filepath.Base(directory) == "" {
		t.Fatal("no directory")
	}
}
