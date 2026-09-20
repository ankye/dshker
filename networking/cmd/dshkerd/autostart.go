package main

// Start-at-boot registration.
//
// A headless host that only serves while an operator is logged in is not a
// headless host. This registers the core with the platform's own supervisor so a
// rebooted machine serves again on its own, using the configuration the operator
// already persisted — which is why this depends on `config.json` rather than
// baking a second copy of those arguments into the registration.
//
// The platform halves live in autostart_darwin.go, autostart_windows.go, and
// autostart_other.go. Each one implements the three verbs below and nothing else,
// so the command surface is identical everywhere and an unsupported platform is a
// typed refusal instead of a silent success.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/ankye/dshker/networking/internal/core"
)

// AutostartState is what every platform reports.
type AutostartState struct {
	// Installed is whether the registration is present right now.
	Installed bool `json:"installed"`
	// Mechanism names the platform facility, for the operator's benefit.
	Mechanism string `json:"mechanism"`
	// Path is the registration this machine reads, when the platform has one.
	Path string `json:"path,omitempty"`
}

// autostartLabel identifies the registration on every platform.
//
// Reverse-DNS because launchd requires it and the same string is reused as the
// Windows task and run-key name, so one machine cannot end up with two
// differently-named registrations for the same core.
const autostartLabel = "com.ankye.dshkerd"

// runAutostart installs, removes, or reports the registration.
func runAutostart(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	verb := args[0]
	flags := flag.NewFlagSet("autostart", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	if flags.Parse(args[1:]) != nil {
		return 2
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	switch verb {
	case "enable":
		// The registration must name the executable that is running now: resolving
		// it later, from a PATH that boot does not necessarily share, is how a
		// registration ends up pointing at nothing.
		executable, execErr := os.Executable()
		if execErr != nil {
			return fail(stderr, errors.New("p2p.autostart_unavailable"))
		}
		if err := installAutostart(executable, directory); err != nil {
			return fail(stderr, err)
		}
	case "disable":
		if err := removeAutostart(); err != nil {
			return fail(stderr, err)
		}
	case "status":
		// Fall through to the shared report below.
	default:
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	reported, err := autostartStatus()
	if err != nil {
		return fail(stderr, err)
	}
	return printAutostart(stdout, stderr, reported)
}

// printAutostart writes one state as the machine-readable answer.
func printAutostart(stdout io.Writer, stderr io.Writer, state AutostartState) int {
	encoded, err := marshalAutostart(state)
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", encoded); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// marshalAutostart encodes one state. Separate so the platform halves do not each
// need an encoder.
func marshalAutostart(state AutostartState) ([]byte, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, errors.New("p2p.autostart_unavailable")
	}
	return encoded, nil
}

// daemonAutostart adapts this binary's platform registration to the core's
// authority, so `core.autostart_*` over the private channel and the `autostart`
// subcommand drive exactly one registration.
type daemonAutostart struct {
	// state is the directory the registration will pass back to `serve`.
	state string
}

func (authority daemonAutostart) Install(context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	return installAutostart(executable, authority.state)
}

func (authority daemonAutostart) Remove(context.Context) error { return removeAutostart() }

func (authority daemonAutostart) Status(context.Context) (core.AutostartView, error) {
	reported, err := autostartStatus()
	if err != nil {
		return core.AutostartView{}, err
	}
	return core.AutostartView{
		Installed: reported.Installed,
		Mechanism: reported.Mechanism,
		Path:      reported.Path,
	}, nil
}
