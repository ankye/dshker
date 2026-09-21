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
	"path/filepath"
	"time"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/localrpc"
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

// autostartTarget is the exact command a platform will run at login. A shared
// label does not imply ownership: another dshkerd installation may have
// registered the same label with a different binary or state directory.
type autostartTarget struct {
	executable string
	state      string
}

func requireAutostartOwnership(executable string, state string) error {
	if !filepath.IsAbs(executable) || !filepath.IsAbs(state) {
		return errors.New("p2p.invalid_arguments")
	}
	registered, installed, err := registeredAutostartTarget()
	if err != nil {
		return err
	}
	if installed && (registered.executable != executable || registered.state != state) {
		return errors.New("p2p.autostart_conflict")
	}
	return nil
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
	if verb != "enable" && verb != "disable" && verb != "status" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
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
	executable, err := os.Executable()
	if err != nil {
		return fail(stderr, errors.New("p2p.autostart_unavailable"))
	}
	if err := requireAutostartOwnership(executable, directory); err != nil {
		return fail(stderr, err)
	}
	switch verb {
	case "enable":
		// The registration must name the executable that is running now: resolving
		// it later, from a PATH that boot does not necessarily share, is how a
		// registration ends up pointing at nothing.
		if err := installAutostart(executable, directory); err != nil {
			return fail(stderr, err)
		}
	case "disable":
		// A running headless core may have an attached desktop: ask that owner
		// to disable without unloading itself. With no published owner, unload
		// the registered launchd job instead, including a serve waiting for the
		// desktop's lock. A stale or malformed record refuses; it never selects
		// the destructive path by guessing the owner's absence.
		recordPath := filepath.Join(directory, localrpc.EndpointFileName)
		info, recordErr := os.Lstat(recordPath)
		if os.IsNotExist(recordErr) {
			if err := removeAutostart(); err != nil {
				return fail(stderr, err)
			}
		} else {
			if recordErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return fail(stderr, errors.New("p2p.autostart_unavailable"))
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			client, closeClient, err := clientFor(ctx, directory)
			if err != nil {
				cancel()
				return fail(stderr, errors.New("p2p.autostart_unavailable"))
			}
			_, err = client.Call(ctx, "core.autostart_disable", struct{}{})
			closeClient()
			cancel()
			if err != nil {
				return fail(stderr, err)
			}
		}
	case "status":
		// Fall through to the shared report below.
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

// headlessAutostart must not stop its own process while answering the desktop's
// disable request. The attached shell explicitly hands ownership back after
// the registration is gone and its response has been observed.
type headlessAutostart struct{ daemonAutostart }

func (authority headlessAutostart) Remove(context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if err := requireAutostartOwnership(executable, authority.state); err != nil {
		return err
	}
	return removeAutostartPreservingProcess()
}

// desktopAutostart configures this shell-owned state for a boot-time serve.
// Both processes take the same OwnerLock before opening stores or a peer host:
// launchd/Run may start the serve command now, but it waits until this desktop
// releases ownership rather than publishing a duplicate device identity.
type desktopAutostart struct {
	state   string
	data    string
	catalog string
	roots   string
}

func (authority desktopAutostart) prepare() error {
	if !filepath.IsAbs(authority.state) || !filepath.IsAbs(authority.data) ||
		!filepath.IsAbs(authority.catalog) ||
		(authority.roots != "" && !filepath.IsAbs(authority.roots)) {
		return errors.New("p2p.autostart_unavailable")
	}
	stored, err := LoadConfig(authority.state)
	if err != nil {
		return err
	}
	// The boot process reads the configuration only after acquiring ownership,
	// so these exact currently-open desktop roots are the ones it will serve.
	stored.DataRoot = authority.data
	stored.CatalogRoot = authority.catalog
	stored.Roots = authority.roots
	return SaveConfig(authority.state, stored)
}

func (authority desktopAutostart) Install(ctx context.Context) error {
	if err := authority.requireOwnership(); err != nil {
		return err
	}
	if err := authority.prepare(); err != nil {
		return err
	}
	return daemonAutostart{state: authority.state}.Install(ctx)
}

func (authority desktopAutostart) Remove(ctx context.Context) error {
	if err := authority.requireOwnership(); err != nil {
		return err
	}
	return daemonAutostart{state: authority.state}.Remove(ctx)
}

func (authority desktopAutostart) Status(ctx context.Context) (core.AutostartView, error) {
	if err := authority.requireOwnership(); err != nil {
		return core.AutostartView{}, err
	}
	view, err := daemonAutostart{state: authority.state}.Status(ctx)
	if err != nil {
		return core.AutostartView{}, err
	}
	return view, nil
}

func (authority desktopAutostart) requireOwnership() error {
	executable, err := os.Executable()
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	return requireAutostartOwnership(executable, authority.state)
}

func (authority daemonAutostart) Install(context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if err := requireAutostartOwnership(executable, authority.state); err != nil {
		return err
	}
	return installAutostart(executable, authority.state)
}

func (authority daemonAutostart) Remove(context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return errors.New("p2p.autostart_unavailable")
	}
	if err := requireAutostartOwnership(executable, authority.state); err != nil {
		return err
	}
	return removeAutostart()
}

func (authority daemonAutostart) Status(context.Context) (core.AutostartView, error) {
	executable, err := os.Executable()
	if err != nil {
		return core.AutostartView{}, errors.New("p2p.autostart_unavailable")
	}
	if err := requireAutostartOwnership(executable, authority.state); err != nil {
		return core.AutostartView{}, err
	}
	reported, err := autostartStatus()
	if err != nil {
		return core.AutostartView{}, err
	}
	return core.AutostartView{
		Installed: reported.Installed,
		Supported: reported.Mechanism != "unsupported",
		Mechanism: reported.Mechanism,
		Path:      reported.Path,
	}, nil
}
