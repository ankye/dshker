package integration

import (
	"bufio"
	"context"
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
