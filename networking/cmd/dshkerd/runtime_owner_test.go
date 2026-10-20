package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func TestRuntimeOwnerPrivateEntryRejectsIncompleteArguments(t *testing.T) {
	for _, args := range [][]string{
		nil, {"--state"}, {"--state", "relative"},
		{"--state", t.TempDir(), "--state", t.TempDir()},
		{"--other", t.TempDir()},
	} {
		if err := runRuntimeOwner(args); err == nil || err.Error() != "runtime.owner_record_invalid" {
			t.Fatalf("private mode accepted malformed arguments: %v", err)
		}
	}
}

func TestRuntimeOwnerConfigKeepsExplicitRootAbsence(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	config, err := ownerConfig(options{stateRoot: state})
	if err != nil || !filepath.IsAbs(config.Executable) || config.StateRoot != state || config.DataRoot != "" || config.CatalogRoot != "" || config.RootsPath != "" {
		t.Fatalf("owner composition changed explicit configuration: %+v, %v", config, err)
	}
}

type canceledResumeBinding struct{ calls int }

func (source *canceledResumeBinding) Binding(ctx context.Context, _ string) (runtimebridge.Binding, error) {
	source.calls++
	return runtimebridge.Binding{}, ctx.Err()
}

func TestHeadlessResumePreservesTheCallCancellation(t *testing.T) {
	source := &canceledResumeBinding{}
	main := headlessMain{binding: &core.RuntimeBinding{Runtime: source, Subject: "subject_main"}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := main.Call(ctx, "runtime.resume", struct{}{}); !errors.Is(err, context.Canceled) || source.calls != 1 {
		t.Fatalf("resume replaced the caller context: %v, calls=%d", err, source.calls)
	}
}

type ownerLifetimeProbe struct {
	created, shutdown bool
	closed            bool
	shutdownErr       error
	closeErr          error
}

func (probe *ownerLifetimeProbe) Created() bool { return probe.created }
func (probe *ownerLifetimeProbe) Shutdown(ctx context.Context) error {
	probe.shutdown = true
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if _, bounded := ctx.Deadline(); !bounded {
		return errors.New("test.shutdown_not_bounded")
	}
	return probe.shutdownErr
}
func (probe *ownerLifetimeProbe) Close() error {
	probe.closed = true
	return probe.closeErr
}

func TestRuntimeOwnerExitKeepsRecoveredRuntimeOnFailedBoot(t *testing.T) {
	for _, test := range []struct {
		name             string
		created, ready   bool
		expectedShutdown bool
	}{
		{"failed recovery", false, false, false},
		{"failed fresh boot", true, false, true},
		{"normal recovered exit", false, true, true},
		{"normal fresh exit", true, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			probe := &ownerLifetimeProbe{created: test.created}
			if err := finishRuntimeOwner(probe, test.ready); err != nil || probe.shutdown != test.expectedShutdown || !probe.closed {
				t.Fatalf("wrong exit ownership: shutdown=%t closed=%t err=%v", probe.shutdown, probe.closed, err)
			}
		})
	}
}

func TestRuntimeOwnerExitDoesNotHideShutdownOrCloseFailure(t *testing.T) {
	shutdownErr := errors.New("runtime.owner_shutdown_failed")
	closeErr := errors.New("test.close_failed")
	probe := &ownerLifetimeProbe{shutdownErr: shutdownErr, closeErr: closeErr}
	err := finishRuntimeOwner(probe, true)
	if !errors.Is(err, shutdownErr) || !errors.Is(err, closeErr) || !probe.closed {
		t.Fatalf("exit lost its exact failure or failed to close: %v", err)
	}
	if err := finishRuntimeOwner(nil, false); err == nil || err.Error() != "runtime.owner_unavailable" {
		t.Fatalf("missing authority was accepted: %v", err)
	}
}
