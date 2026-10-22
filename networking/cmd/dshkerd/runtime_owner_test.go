package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
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

func TestRefusedRuntimeAuthorityRetainsEveryOperationFailure(t *testing.T) {
	cause := errors.Join(runtimeowner.ErrOwnerRecordInvalid, errors.New("test.original_owner_failure"))
	public := publicRuntimeOwnerFailure(cause)
	if public.Error() != "runtime.owner_record_invalid" || !errors.Is(public, cause) {
		t.Fatal("public refusal leaked diagnostic text or dropped its original cause")
	}
	authority := refusedRuntimeAuthority{cause: public}
	ctx := context.Background()
	started, err := authority.Start(ctx, harnessruntime.LaunchRequest{})
	if err != public || started != (harnessruntime.LaunchView{}) {
		t.Fatal("start hid the original refusal or claimed a launch")
	}
	stopped, err := authority.Stop(ctx, "subject_main")
	if err != public || stopped != (harnessruntime.LaunchView{}) {
		t.Fatal("stop hid the original refusal or claimed a stopped child")
	}
	status, present, err := authority.Status(ctx, "subject_main")
	if err != public || present || status != (harnessruntime.LaunchView{}) {
		t.Fatal("status hid the original refusal as an absent launch")
	}
	entries, cursor, err := authority.Console(ctx, 9)
	if err != public || entries != nil || cursor != 0 {
		t.Fatal("console hid the original refusal as an empty feed")
	}
	binding, err := authority.Binding(ctx, "subject_main")
	if err != public || binding != (runtimebridge.Binding{}) {
		t.Fatal("binding hid the original refusal or returned a cached address")
	}
}

func TestRuntimeAdmissionFailureHasNoCleanupAuthority(t *testing.T) {
	authority, lifetime, failure := admitRuntimeAuthority(context.Background(), options{stateRoot: "relative"})
	if lifetime != nil || !errors.Is(failure, runtimeowner.ErrOwnerConfiguration) {
		t.Fatalf("invalid owner was admitted or given a cleanup lifetime: %v", failure)
	}
	if _, _, err := authority.Status(context.Background(), "subject_main"); !errors.Is(err, failure) || err.Error() != failure.Error() {
		t.Fatal("runtime boundary did not retain the exact admission failure")
	}
}

func TestRuntimeOwnerPublicFailuresKeepOnlyAdmittedCodes(t *testing.T) {
	for _, code := range []error{
		runtimeowner.ErrOwnerUnavailable, runtimeowner.ErrOwnerIdentityMismatch,
		runtimeowner.ErrOwnerRecordInvalid, runtimeowner.ErrOwnerProtocol,
		runtimeowner.ErrOwnerConfiguration, runtimeowner.ErrOwnerShutdown,
	} {
		original := errors.Join(code, errors.New("record publish errno=5 private-stage-detail"))
		public := publicRuntimeOwnerFailure(original)
		if public.Error() != code.Error() || !errors.Is(public, original) || !errors.Is(public, code) {
			t.Fatalf("public owner failure changed its code or lost local diagnostics: %v", code)
		}
	}
	unknown := errors.New("unknown private operating-system failure")
	public := publicRuntimeOwnerFailure(unknown)
	if public.Error() != runtimeowner.ErrOwnerUnavailable.Error() || !errors.Is(public, unknown) {
		t.Fatal("unknown admission failure was exposed or mistaken for success")
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
