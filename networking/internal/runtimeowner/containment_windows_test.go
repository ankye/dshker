//go:build windows

package runtimeowner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsOwnerShutdownJoinsNestedDescendants(t *testing.T) {
	for _, mode := range []string{"root-running", "root-exits"} {
		t.Run(mode, func(t *testing.T) {
			config, client, _, _, _ := recoveryOwner(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			request, directory := containmentRequest(t, config, "subject_nested", "launch_nested", mode, "nested")
			if _, err := client.Start(ctx, request); err != nil {
				t.Fatal(err)
			}
			root, leaf := readProbeProcess(t, directory, "root"), readProbeProcess(t, directory, "leaf")
			if mode == "root-exits" {
				waitProbeExit(t, root)
				if _, err := client.Stop(ctx, request.SubjectID); err != nil {
					t.Fatal(err)
				}
				journal, _, err := readRecoveryJournal(filepath.Join(config.StateRoot, ownerDirectory, recoveryFileName))
				if err != nil || journal.Phase == "idle" {
					t.Fatal("root exit relabeled a surviving detached grandchild as idle")
				}
			}
			if err := client.Shutdown(ctx); err != nil {
				t.Fatalf("explicit shutdown did not join its kernel-owned descendants: %v", err)
			}
			waitProbeExit(t, root)
			waitProbeExit(t, leaf)
			for _, name := range []string{recordFileName, recoveryFileName} {
				if _, err := os.Lstat(filepath.Join(config.StateRoot, ownerDirectory, name)); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("normal shutdown retained runtime evidence after joining all descendants")
				}
			}
		})
	}
}

func TestWindowsOwnerCrashTerminatesNestedJobBeforeRecovery(t *testing.T) {
	config, client, _, _, _ := recoveryOwner(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, directory := containmentRequest(t, config, "subject_crash_nested", "launch_crash_nested", "root-running", "crash-nested")
	if _, err := client.Start(ctx, request); err != nil {
		t.Fatal(err)
	}
	root, leaf := readProbeProcess(t, directory, "root"), readProbeProcess(t, directory, "leaf")
	killOwnedTestOwner(t, client)
	waitProbeExit(t, root)
	waitProbeExit(t, leaf)
	replacement, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutdownOwner(t, replacement) })
	if !replacement.Created() || replacement.record.Instance == client.record.Instance {
		t.Fatal("crashed contained ownership was not archived before replacement")
	}
}

func TestWindowsRecoveryRefusesJobWithLiveDescendants(t *testing.T) {
	config, client, _, _, _ := recoveryOwner(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, directory := containmentRequest(t, config, "subject_held_job", "launch_held_job", "root-running", "held-job")
	if _, err := client.Start(ctx, request); err != nil {
		t.Fatal(err)
	}
	root, leaf := readProbeProcess(t, directory, "root"), readProbeProcess(t, directory, "leaf")
	name, err := containmentName(client.record.Instance)
	if err != nil {
		t.Fatal(err)
	}
	value, _, _ := openPrivateJob.Call(0x0004|0x00020000, 0, uintptr(unsafe.Pointer(name)))
	if value == 0 {
		t.Fatal("test could not open its exact private owner job")
	}
	held := windows.Handle(value)
	t.Cleanup(func() {
		if held != 0 {
			windows.CloseHandle(held)
		}
	})
	recordRaw, _ := os.ReadFile(filepath.Join(config.StateRoot, ownerDirectory, recordFileName))
	journalRaw, _ := os.ReadFile(filepath.Join(config.StateRoot, ownerDirectory, recoveryFileName))
	killOwnedTestOwner(t, client)
	short, stop := context.WithTimeout(ctx, 150*time.Millisecond)
	_, err = Open(short, config)
	stop()
	if !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("live job descendants admitted duplicate ownership: %v", err)
	}
	assertRecoveryBytes(t, filepath.Join(config.StateRoot, ownerDirectory), recordRaw, journalRaw)
	if actual, err := processIdentityAt(leaf.PID); err != nil || actual != leaf {
		t.Fatal("refused recovery mutated a live descendant")
	}
	windows.CloseHandle(held)
	held = 0
	waitProbeExit(t, root)
	waitProbeExit(t, leaf)
	replacement, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutdownOwner(t, replacement) })
}

func TestWindowsExistingJobIsNeverAdopted(t *testing.T) {
	_, client, record, _, _ := recoveryOwner(t)
	t.Cleanup(func() { shutdownOwner(t, client) })
	if guard, err := newProcessContainment(record); !errors.Is(err, ErrOwnerIdentityMismatch) {
		if guard != nil {
			guard.close(false)
		}
		t.Fatalf("existing job was adopted instead of refused: %v", err)
	}
	if actual, err := processIdentityAt(record.Process.PID); err != nil || actual != record.Process {
		t.Fatal("collision changed the real owner")
	}
}
