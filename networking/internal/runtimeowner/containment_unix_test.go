//go:build !windows

package runtimeowner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestUnixSameSubjectCannotForgetSurvivingHistoricalGroup(t *testing.T) {
	config, client, _, _, _ := recoveryOwner(t)
	t.Cleanup(func() { killOwnedTestOwner(t, client) })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	first, firstDirectory := containmentRequest(t, config, "subject_history", "launch_history_first", "root-exits", "history-first")
	firstView, err := client.Start(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	// These exact groups were created by this isolated owner/test request only.
	t.Cleanup(func() { _ = syscall.Kill(-firstView.PID, syscall.SIGKILL) })
	firstRoot := readProbeProcess(t, firstDirectory, "root")
	firstLeaf := readProbeProcess(t, firstDirectory, "leaf")
	waitProbeExit(t, firstRoot)
	if _, err := client.Stop(ctx, first.SubjectID); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(config.StateRoot, ownerDirectory, recoveryFileName)
	if journal, _, err := readRecoveryJournal(journalPath); err != nil || journal.Phase == "idle" {
		t.Fatal("root exit cleared a still-live process group")
	}
	second, secondDirectory := containmentRequest(t, config, "subject_history", "launch_history_second", "root-running-clean-leaf", "history-second")
	secondView, err := client.Start(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-secondView.PID, syscall.SIGKILL) })
	_ = readProbeProcess(t, secondDirectory, "leaf")
	if _, err := client.Stop(ctx, second.SubjectID); err != nil {
		t.Fatal(err)
	}
	waitOwner(t, "second exact group did not exit", func() bool { return errors.Is(syscall.Kill(-secondView.PID, 0), syscall.ESRCH) })
	// Poll Stop once more after the latest group is definitely gone. Only the
	// retained historical group can now prevent the durable idle assertion.
	if _, err := client.Stop(ctx, second.SubjectID); err != nil {
		t.Fatal(err)
	}
	if journal, _, err := readRecoveryJournal(journalPath); err != nil || journal.Phase == "idle" {
		t.Fatal("same-subject restart forgot its surviving historical group")
	}
	if actual, err := processIdentityAt(firstLeaf.PID); err != nil || actual != firstLeaf {
		t.Fatal("historical-group refusal changed the retained child")
	}
	if err := client.Shutdown(ctx); !errors.Is(err, ErrOwnerShutdown) {
		t.Fatalf("unjoined historical group was reported fully shut down: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(config.StateRoot, ownerDirectory, recordFileName)); err != nil {
		t.Fatal("unjoined group lost owner evidence")
	}
}

func TestUnixIdleRecoveryAllowsRemovedCleanupEndpoint(t *testing.T) {
	config, client, record, _, _ := recoveryOwner(t)
	killOwnedTestOwner(t, client)
	if err := os.Remove(record.Socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if err := os.Remove(record.SocketDirectory); err != nil {
		t.Fatal(err)
	}
	recovered, err := Open(context.Background(), config)
	if err != nil {
		t.Fatalf("proven idle cleanup crash did not recover missing endpoint directory: %v", err)
	}
	t.Cleanup(func() { shutdownOwner(t, recovered) })
	if !recovered.Created() {
		t.Fatal("cleanup crash did not create a new authenticated owner")
	}
}
