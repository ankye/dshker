package integration

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// A rejected launch that never created a child must not poison an otherwise
// empty production authority or turn a normal Quit into an abandoned record.
func TestProductionRuntimeOwnerRejectedStartKeepsIdleAuthority(t *testing.T) {
	recoveryNamespace(t)
	binary := isolationCoreBinary(t)
	for _, reason := range []string{"missing-built-entry", "unresolved-package-manager", "missing-executable"} {
		t.Run(reason, func(t *testing.T) {
			config := runtimeowner.Config{Executable: binary, StateRoot: stateDirectoryForCLI(t)}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			owner, err := runtimeowner.Open(ctx, config)
			must(t, err)
			t.Cleanup(func() { recoveryCleanupRejectedStart(t, config, owner) })
			request := harnessruntime.LaunchRequest{
				LaunchID: "launch_rejected", SubjectID: "subject_rejected", Directory: t.TempDir(),
				Profile: harnessruntime.ProfileNode, NodeExecutable: binary, Port: harnessruntime.AutoPort(),
			}
			wanted := harnessruntime.ErrWorktreeInvalid
			if reason != "missing-built-entry" {
				request.Profile = harnessruntime.ProfilePnpm
				request.NodeExecutable = ""
				request.PnpmExecutable = filepath.Join(t.TempDir(), "absent-package-manager")
				request.DiagnosticsPatchPath = filepath.Join(t.TempDir(), "overlay.yml")
				request.LogPath = filepath.Join(t.TempDir(), "dsh-web.log")
				wanted = harnessruntime.ErrSpawnFailed
				if reason == "unresolved-package-manager" {
					request.PnpmResolutionError = "Required package manager is unavailable."
				}
			}
			if _, err := owner.Start(ctx, request); !errors.Is(err, wanted) {
				t.Fatalf("known pre-child refusal did not preserve its typed cause: %v", err)
			}
			if _, present, err := owner.Status(ctx, request.SubjectID); err != nil || present {
				t.Fatalf("rejected launch created a child or lost authority: present=%v error=%v", present, err)
			}
			recoveryCaptureOwner(t, config.StateRoot)
			must(t, owner.Shutdown(ctx))
			must(t, owner.Close())
			if _, err := os.Stat(filepath.Join(config.StateRoot, "runtime-owner", "owner.json")); !os.IsNotExist(err) {
				t.Fatal("a known rejected launch left an owner record after normal Quit")
			}
		})
	}
}

func recoveryCleanupRejectedStart(t *testing.T, config runtimeowner.Config, owner *runtimeowner.Client) {
	t.Helper()
	defer owner.Close()
	if _, err := os.Stat(filepath.Join(config.StateRoot, "runtime-owner", "owner.json")); os.IsNotExist(err) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := owner.Shutdown(ctx); err == nil {
		return
	} else {
		t.Errorf("known no-child rejection blocked normal owner cleanup: %v", err)
	}
	// Only a failed regression reaches this path. All tested failures happened
	// before creation of a child; identify this exact test-owned authority again
	// before ending it, so a red test never leaves a running background process.
	identity, err := runtimeowner.InspectIdentity(config)
	if err != nil || identity != owner.Identity() {
		t.Error("failed rejection cleanup could not verify its exact test-owned authority")
		return
	}
	process, err := os.FindProcess(identity.PID)
	if err != nil {
		t.Error(err)
		return
	}
	if err := process.Kill(); err != nil {
		t.Error(err)
	}
	_ = process.Release()
}
