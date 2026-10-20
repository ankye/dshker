package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// ownerConfig preserves configured absence. In particular, an unconfigured
// credential/catalog root is not replaced with state, home, or app-data.
func ownerConfig(parsed options) (runtimeowner.Config, error) {
	executable, err := os.Executable()
	if err != nil {
		return runtimeowner.Config{}, errors.New("runtime.owner_identity_mismatch")
	}
	return runtimeowner.Config{
		Executable: executable, StateRoot: parsed.stateRoot, DataRoot: parsed.dataRoot,
		CatalogRoot: parsed.catalogRoot, RootsPath: parsed.rootsPath,
	}, nil
}

func openRuntimeOwner(ctx context.Context, parsed options) (*runtimeowner.Client, error) {
	config, err := ownerConfig(parsed)
	if err != nil {
		return nil, err
	}
	return runtimeowner.Open(ctx, config)
}

func runRuntimeOwner(args []string) error {
	parsed, err := parseArguments(args)
	if err != nil || parsed.stateRoot == "" {
		return errors.New("runtime.owner_record_invalid")
	}
	config, err := ownerConfig(parsed)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return runtimeowner.Run(ctx, config)
}

// A failed boot cannot terminate an authority it recovered because unrelated
// setup failed. It does join its own freshly created empty authority. A ready
// core's orderly shutdown explicitly joins the runtime. SIGKILL runs neither
// path; the independent authority and its actual children stay alive.
type runtimeOwnerLifetime interface {
	Created() bool
	Shutdown(context.Context) error
	Close() error
}

func finishRuntimeOwner(client runtimeOwnerLifetime, ready bool) error {
	if client == nil {
		return errors.New("runtime.owner_unavailable")
	}
	var shutdownErr error
	if ready || client.Created() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		shutdownErr = client.Shutdown(ctx)
		cancel()
	}
	return errors.Join(shutdownErr, client.Close())
}
