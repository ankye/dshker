package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// ownerConfig preserves configured absence. In particular, an unconfigured
// credential/catalog root is not replaced with state, home, or app-data.
func ownerConfig(parsed options) (runtimeowner.Config, error) {
	executable, err := os.Executable()
	if err != nil {
		return runtimeowner.Config{}, errors.Join(runtimeowner.ErrOwnerIdentityMismatch, err)
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

// admitRuntimeAuthority keeps a runtime refusal at the runtime boundary. Account,
// catalog and remote-computer operations do not own a local DSH process and must
// remain available when that independent authority cannot be admitted. The
// refusal never replaces its record, creates a supervisor or claims an empty
// runtime. Only the successfully authenticated client has a cleanup lifetime.
func admitRuntimeAuthority(ctx context.Context, parsed options) (harnessruntime.Authority, *runtimeowner.Client, error) {
	client, err := openRuntimeOwner(ctx, parsed)
	if err != nil {
		return refusedRuntimeAuthority{cause: publicRuntimeOwnerFailure(err)}, nil, err
	}
	return client, client, nil
}

type refusedRuntimeAuthority struct{ cause error }

// The wire receives only one admitted public code. The original operation
// failure remains available to local errors.Is/As callers and the startup log;
// filesystem stage/errno details do not become renderer-visible error text.
type runtimeOwnerPublicFailure struct{ code, cause error }

func (failure *runtimeOwnerPublicFailure) Error() string { return failure.code.Error() }
func (failure *runtimeOwnerPublicFailure) Unwrap() []error {
	return []error{failure.code, failure.cause}
}

func publicRuntimeOwnerFailure(cause error) error {
	for _, code := range []error{
		runtimeowner.ErrOwnerUnavailable, runtimeowner.ErrOwnerIdentityMismatch,
		runtimeowner.ErrOwnerRecordInvalid, runtimeowner.ErrOwnerProtocol,
		runtimeowner.ErrOwnerConfiguration, runtimeowner.ErrOwnerShutdown,
	} {
		if errors.Is(cause, code) {
			return &runtimeOwnerPublicFailure{code: code, cause: cause}
		}
	}
	// Admission failed, so an unknown local failure cannot be an empty runtime or
	// a new owner. Keep its cause privately while refusing an unavailable owner.
	return &runtimeOwnerPublicFailure{code: runtimeowner.ErrOwnerUnavailable, cause: cause}
}

func (refusal refusedRuntimeAuthority) Start(context.Context, harnessruntime.LaunchRequest) (harnessruntime.LaunchView, error) {
	return harnessruntime.LaunchView{}, refusal.cause
}

func (refusal refusedRuntimeAuthority) Stop(context.Context, string) (harnessruntime.LaunchView, error) {
	return harnessruntime.LaunchView{}, refusal.cause
}

func (refusal refusedRuntimeAuthority) Status(context.Context, string) (harnessruntime.LaunchView, bool, error) {
	return harnessruntime.LaunchView{}, false, refusal.cause
}

func (refusal refusedRuntimeAuthority) Console(context.Context, int64) ([]harnessruntime.ConsoleEntry, int64, error) {
	return nil, 0, refusal.cause
}

func (refusal refusedRuntimeAuthority) Binding(context.Context, string) (runtimebridge.Binding, error) {
	return runtimebridge.Binding{}, refusal.cause
}

var _ harnessruntime.Authority = refusedRuntimeAuthority{}

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
