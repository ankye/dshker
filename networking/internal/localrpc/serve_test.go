package localrpc

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// stateDirectory returns a private state directory the listener accepts.
func stateDirectory(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "windows" {
		// A Unix socket path is capped near 104 bytes, so the state directory has
		// to be short: t.TempDir() under $TMPDIR is far longer than that.
		directory, err := os.MkdirTemp("/tmp", "dshkerd")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(directory) })
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		return directory
	}
	return t.TempDir()
}

// endpointIn returns an endpoint this platform accepts inside one directory.
func endpointIn(t *testing.T, directory string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		secret, err := NewSecret()
		if err != nil {
			t.Fatal(err)
		}
		return `\\\\.\\pipe\\dshker-peer-` + secret[:32]
	}
	return filepath.Join(directory, "peer.sock")
}

func TestEndpointRecordRoundTripsAndRefusesAnythingElse(t *testing.T) {
	directory := stateDirectory(t)
	path := filepath.Join(directory, EndpointFileName)
	secret, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(secret) != 64 {
		t.Fatalf("secret = %q", secret)
	}
	record := Bootstrap{Version: 1, Socket: endpointIn(t, directory), Secret: secret}
	if err := WriteEndpointRecord(path, record); err != nil {
		t.Fatalf("write: %v", err)
	}
	read, err := ReadEndpointRecord(path)
	if err != nil || read != record {
		t.Fatalf("read = %+v, %v", read, err)
	}
	if info, err := os.Stat(path); err == nil && runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}

	// Only the one file name is owned, and a malformed record is refused.
	if err := WriteEndpointRecord(filepath.Join(directory, "core.txt"), record); err == nil {
		t.Fatal("another file name was accepted")
	}
	if err := os.WriteFile(path, []byte("{\"version\":1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadEndpointRecord(path); err == nil {
		t.Fatal("a record without a secret was accepted")
	}
}

// TestServeEndpointAnswersAuthenticatedClients drives the headless pair: one
// listener, two sequential clients, and one refusal for a client that does not
// know the secret.
func TestServeEndpointAnswersAuthenticatedClients(t *testing.T) {
	directory := stateDirectory(t)
	endpoint := endpointIn(t, directory)
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	if runtime.GOOS != "windows" {
		defer os.Remove(endpoint)
	}
	secret, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan error, 1)
	go func() {
		served <- ServeEndpoint(ctx, listener, secret, func(_ context.Context, method string, payload json.RawMessage) (any, error) {
			if method != "core.version" {
				return nil, errors.New("p2p.invalid_operation")
			}
			return struct {
				Version int `json:"version"`
			}{1}, nil
		})
	}()

	call := func(secret string) (json.RawMessage, error) {
		conn, err := Connect(ctx, endpoint, secret)
		if err != nil {
			return nil, err
		}
		peer := New(ctx, conn, nil)
		defer peer.Close()
		return peer.Call(ctx, "core.version", struct{}{})
	}
	for attempt := 0; attempt < 2; attempt++ {
		answer, err := call(secret)
		if err != nil {
			t.Fatalf("call %d: %v", attempt, err)
		}
		if string(answer) != "{\"version\":1}" {
			t.Fatalf("answer = %s", answer)
		}
	}
	// A client that does not know the secret is refused, and the daemon keeps
	// serving: the next command is a new connection.
	other, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(other); err == nil {
		t.Fatal("a foreign secret was accepted")
	}
	if _, err := call(secret); err != nil {
		t.Fatalf("the daemon stopped after a refusal: %v", err)
	}
	cancel()
	select {
	case <-served:
	case <-time.After(5 * time.Second):
		t.Fatal("ServeEndpoint did not return after the context ended")
	}
}
