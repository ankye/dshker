package integration

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

const (
	coreReadiness     = "{\"version\":1,\"ready\":true}\n"
	coreAuthenticated = "{\"version\":1,\"authenticated\":true}\n"
	corePackage       = "github.com/ankye/dshker/networking/cmd/dshkerd"
)

// TestCoreDaemonServesThePrivateChannel runs the real dshkerd binary through the
// contract in networking/docs/shell-core-protocol.md: bootstrap, readiness,
// authentication, one call, a typed refusal, a refused second client, and an
// exit that follows the parent channel.
func TestCoreDaemonServesThePrivateChannel(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "dshkerd")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	// The test asserts protocol behavior, so it must not depend on a VCS tool
	// being resolvable: Go stamps VCS information into a binary by default and
	// fails the build when git is missing from PATH.
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	build.Stderr = os.Stderr
	must(t, build.Run())

	version, err := exec.Command(binary, "--version").Output()
	must(t, err)
	if strings.TrimSpace(string(version)) != "dshkerd/1" {
		t.Fatalf("dshkerd --version = %q", version)
	}
	if exec.Command(binary, "serve-unknown").Run() == nil {
		t.Fatal("dshkerd accepted an unknown argument")
	}

	endpoint := coreEndpoint(t)
	secret := strings.Repeat("a", 64)
	cmd := exec.Command(binary)
	stdin, err := cmd.StdinPipe()
	must(t, err)
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	daemon := launch(t, cmd)

	record, err := json.Marshal(localrpc.Bootstrap{Version: 1, Socket: endpoint, Secret: secret})
	must(t, err)
	_, err = stdin.Write(append(record, '\n'))
	must(t, err)
	// The reader consumes stdin until EOF, so the record must be terminated.
	must(t, stdin.Close())

	line, err := bufio.NewReader(stdout).ReadString('\n')
	must(t, err)
	if line != coreReadiness {
		t.Fatalf("readiness = %q", line)
	}

	conn, err := dialCore(endpoint)
	must(t, err)
	authentication, err := json.Marshal(localrpc.Authentication{Version: 1, Secret: secret})
	must(t, err)
	_, err = conn.Write(append(authentication, '\n'))
	must(t, err)
	acknowledgement := make([]byte, len(coreAuthenticated))
	_, err = io.ReadFull(conn, acknowledgement)
	must(t, err)
	if string(acknowledgement) != coreAuthenticated {
		t.Fatalf("authentication = %q", acknowledgement)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	parent := localrpc.New(ctx, conn, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.invalid_operation")
	})
	payload, err := parent.Call(ctx, "core.version", struct{}{})
	must(t, err)
	if !strings.Contains(string(payload), "\"methodTableVersion\":1") {
		t.Fatalf("core.version = %s", payload)
	}
	if _, err = parent.Call(ctx, "devices.list", struct{}{}); err == nil || err.Error() != "p2p.not_implemented" {
		t.Fatalf("unimplemented method = %v", err)
	}
	if _, err = parent.Call(ctx, "nope.nope", struct{}{}); err == nil || err.Error() != "p2p.invalid_operation" {
		t.Fatalf("unknown method = %v", err)
	}

	// The single Accept is long past, so a second client that never received
	// the bootstrap must be refused.
	if extra, err := dialCore(endpoint); err == nil {
		extra.Close()
		t.Fatal("a second, unbootstrapped client was admitted")
	}

	// The core is a child, not a daemon: it exits when its parent channel ends.
	parent.Close()
	select {
	case <-daemon.done:
	case <-time.After(5 * time.Second):
		t.Fatal("dshkerd outlived its parent channel")
	}
}

// TestCoreDaemonServesWithADataRoot covers the --data argument the
// CoreSupervisor passes: the daemon refuses a malformed root, opens the
// platform secret store rooted at the directory at boot, and serves
// core.version end to end.
func TestCoreDaemonServesWithADataRoot(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "dshkerd")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	build.Stderr = os.Stderr
	must(t, build.Run())

	if exec.Command(binary, "--data").Run() == nil {
		t.Fatal("dshkerd accepted --data without a value")
	}
	if runtime.GOOS == "windows" {
		if exec.Command(binary, "--data", filepath.Join(t.TempDir(), "absent")).Run() == nil {
			t.Fatal("dshkerd accepted a nonexistent --data root")
		}
	}

	endpoint := coreEndpoint(t)
	secretValue := strings.Repeat("b", 64)
	cmd := exec.Command(binary, "--data", t.TempDir())
	stdin, err := cmd.StdinPipe()
	must(t, err)
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	daemon := launch(t, cmd)

	record, err := json.Marshal(localrpc.Bootstrap{Version: 1, Socket: endpoint, Secret: secretValue})
	must(t, err)
	_, err = stdin.Write(append(record, '\n'))
	must(t, err)
	must(t, stdin.Close())

	line, err := bufio.NewReader(stdout).ReadString('\n')
	must(t, err)
	if line != coreReadiness {
		t.Fatalf("readiness = %q", line)
	}

	conn, err := dialCore(endpoint)
	must(t, err)
	authentication, err := json.Marshal(localrpc.Authentication{Version: 1, Secret: secretValue})
	must(t, err)
	_, err = conn.Write(append(authentication, '\n'))
	must(t, err)
	acknowledgement := make([]byte, len(coreAuthenticated))
	_, err = io.ReadFull(conn, acknowledgement)
	must(t, err)
	if string(acknowledgement) != coreAuthenticated {
		t.Fatalf("authentication = %q", acknowledgement)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	parent := localrpc.New(ctx, conn, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.invalid_operation")
	})
	payload, err := parent.Call(ctx, "core.version", struct{}{})
	must(t, err)
	if !strings.Contains(string(payload), "\"methodTableVersion\":1") {
		t.Fatalf("core.version = %s", payload)
	}

	// The core is a child, not a daemon: it exits when its parent channel ends.
	parent.Close()
	select {
	case <-daemon.done:
	case <-time.After(5 * time.Second):
		t.Fatal("dshkerd outlived its parent channel")
	}
}

// coreSession owns one dshkerd process with an authenticated parent.
type coreSession struct {
	parent *localrpc.Peer
	done   <-chan error
}

// bootCore launches a daemon session with the given arguments and returns it
// with an authenticated parent peer ready to call.
func bootCore(t *testing.T, binary string, args ...string) *coreSession {
	t.Helper()
	endpoint := coreEndpoint(t)
	secretValue := strings.Repeat("c", 64)
	cmd := exec.Command(binary, args...)
	stdin, err := cmd.StdinPipe()
	must(t, err)
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	daemon := launch(t, cmd)
	record, err := json.Marshal(localrpc.Bootstrap{Version: 1, Socket: endpoint, Secret: secretValue})
	must(t, err)
	_, err = stdin.Write(append(record, '\n'))
	must(t, err)
	must(t, stdin.Close())
	line, err := bufio.NewReader(stdout).ReadString('\n')
	must(t, err)
	if line != coreReadiness {
		t.Fatalf("readiness = %q", line)
	}
	conn, err := dialCore(endpoint)
	must(t, err)
	authentication, err := json.Marshal(localrpc.Authentication{Version: 1, Secret: secretValue})
	must(t, err)
	_, err = conn.Write(append(authentication, '\n'))
	must(t, err)
	acknowledgement := make([]byte, len(coreAuthenticated))
	_, err = io.ReadFull(conn, acknowledgement)
	must(t, err)
	if string(acknowledgement) != coreAuthenticated {
		t.Fatalf("authentication = %q", acknowledgement)
	}
	return &coreSession{
		parent: localrpc.New(context.Background(), conn, func(context.Context, string, json.RawMessage) (any, error) {
			return nil, errors.New("p2p.invalid_operation")
		}),
		done: daemon.done,
	}
}

// stop closes the parent channel and asserts the daemon follows it.
func (session *coreSession) stop(t *testing.T) {
	t.Helper()
	session.parent.Close()
	select {
	case <-session.done:
	case <-time.After(5 * time.Second):
		t.Fatal("dshkerd outlived its parent channel")
	}
}

// readSecret calls core.secret_get and returns the decoded plaintext.
func readSecret(t *testing.T, parent *localrpc.Peer, ctx context.Context, key string) string {
	t.Helper()
	payload, err := parent.Call(ctx, "core.secret_get", map[string]string{"key": key})
	must(t, err)
	var response struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatalf("secret_get payload %s: %v", payload, err)
	}
	decoded, err := base64.StdEncoding.DecodeString(response.Value)
	must(t, err)
	return string(decoded)
}

// TestCoreDaemonSecretRoundTrip drives core.secret_set/get/delete through the
// private channel. A daemon restart against the same data root must observe the
// value the previous process persisted ("created by the previous release still
// serves" at the method level), and a core without a data root must refuse
// every secret method with a typed code instead of a fallback.
func TestCoreDaemonSecretRoundTrip(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "dshkerd")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	build.Stderr = os.Stderr
	must(t, build.Run())

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	dataRoot := t.TempDir()
	key := "dshker.peer.credential." + strings.Repeat("d", 64)
	plaintext := `{"serviceId":"` + strings.Repeat("e", 64) + `","name":"previous release"}`
	value := base64.StdEncoding.EncodeToString([]byte(plaintext))

	// First process: write the value and read it back, then exit.
	first := bootCore(t, binary, "--data", dataRoot)
	if _, err := first.parent.Call(ctx, "core.secret_set", map[string]string{"key": key, "value": value}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if got := readSecret(t, first.parent, ctx, key); got != plaintext {
		t.Fatalf("set/get mismatch: %q != %q", got, plaintext)
	}
	first.stop(t)

	// A restart against the same root must serve the persisted value; a delete
	// then makes the key missing again.
	second := bootCore(t, binary, "--data", dataRoot)
	if got := readSecret(t, second.parent, ctx, key); got != plaintext {
		t.Fatalf("restart lost the value: %q != %q", got, plaintext)
	}
	if _, err := second.parent.Call(ctx, "core.secret_delete", map[string]string{"key": key}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := second.parent.Call(ctx, "core.secret_get", map[string]string{"key": key}); err == nil || err.Error() != "p2p.secret_missing" {
		t.Fatalf("get after delete = %v", err)
	}
	second.stop(t)

	// A core without a data root has no provider and says so, typed.
	third := bootCore(t, binary)
	if _, err := third.parent.Call(ctx, "core.secret_get", map[string]string{"key": key}); err == nil || err.Error() != "p2p.secret_provider_unavailable" {
		t.Fatalf("get without a root = %v", err)
	}
	if _, err := third.parent.Call(ctx, "core.secret_set", map[string]string{"key": key, "value": value}); err == nil || err.Error() != "p2p.secret_provider_unavailable" {
		t.Fatalf("set without a root = %v", err)
	}
	third.stop(t)
}
