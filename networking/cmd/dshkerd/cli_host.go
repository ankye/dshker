package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

// runProxy prints the runtime binding this host hands to a peer: the loopback
// address a remote opens this machine's workbench at, and the generation that
// identifies the current child. It is the reverse-proxy half of hosting, asked
// directly so a machine with no display can see exactly what a peer is given.
func runProxy(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("proxy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	asJSON := flags.Bool("json", false, "print the binding as JSON")
	if flags.Parse(args) != nil {
		return 2
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, directory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	answer, err := client.Call(ctx, "core.runtime_binding", struct{}{})
	if err != nil {
		return fail(stderr, err)
	}
	var binding struct {
		Generation uint64 `json:"generation"`
		URL        string `json:"url"`
	}
	if json.Unmarshal(answer, &binding) != nil || binding.Generation == 0 || binding.URL == "" {
		return fail(stderr, errors.New("p2p.invalid_result"))
	}
	if *asJSON {
		if _, err := fmt.Fprintf(stdout, "%s\n", strings.TrimSpace(string(answer))); err != nil {
			return fail(stderr, err)
		}
		return 0
	}
	if _, err := fmt.Fprintf(stdout, "proxy generation %d: %s\n", binding.Generation, binding.URL); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// runService configures one coordinator account on a headless host. It is the
// same service.configure call the shell makes when a user enters a coordinator,
// with the endpoints read from flags instead of a settings page, and it reports
// the service identity the coordinator answered with.
func runService(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "configure" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	flags := flag.NewFlagSet("service configure", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	origin := flags.String("origin", "", "coordinator HTTPS origin")
	wss := flags.String("wss", "", "coordinator WebSocket URL")
	stun := flags.String("stun", "", "STUN address")
	pinnedKeyFile := flags.String("pinned-key", "", "file holding the coordinator's 32-byte pinned key")
	version := flags.String("version", "", "the version this build reports")
	if flags.Parse(args[1:]) != nil {
		return 2
	}
	if *origin == "" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	pinnedKey, err := readPinnedKey(*pinnedKeyFile)
	if err != nil {
		return fail(stderr, err)
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, directory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	answer, err := client.Call(ctx, "service.configure", struct {
		Endpoints controlplane.Endpoints `json:"endpoints"`
		PinnedKey []byte                 `json:"pinnedKey"`
		Telemetry controlplane.Telemetry `json:"telemetry"`
	}{
		Endpoints: controlplane.Endpoints{HTTPSOrigin: *origin, WSSURL: *wss, STUNAddress: *stun},
		PinnedKey: pinnedKey,
		Telemetry: controlplane.Telemetry{Version: *version, Platform: runtime.GOOS, Architecture: runtime.GOARCH},
	})
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", strings.TrimSpace(string(answer))); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// readPinnedKey reads an optional pinned coordinator key. An absent file is no
// pin at all; a present file must hold exactly the 32 bytes the host admits, so
// a truncated or padded key is refused here rather than by the coordinator.
func readPinnedKey(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("p2p.helper_configuration_required")
	}
	if len(value) != 32 {
		return nil, errors.New("p2p.invalid_arguments")
	}
	return value, nil
}
