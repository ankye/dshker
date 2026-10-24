package runtimeowner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func TestBootSessionIdentityIsStableAndNotEmpty(t *testing.T) {
	first, err := currentBootID()
	if err != nil || !hexValue(first, 64) {
		t.Fatalf("native boot identity is unavailable: %v", err)
	}
	second, err := currentBootID()
	if err != nil || second != first {
		t.Fatal("native boot session changed without an actual reboot")
	}
	for _, invalid := range []string{"", "unknown", strings.Repeat("0", 32), "2026-10-25T00:00:00Z"} {
		if _, err := bootSessionDigest(invalid); !errors.Is(err, ErrOwnerUnavailable) {
			t.Fatal("missing boot identity was replaced by an invented value")
		}
	}
	if _, err := recordedProcessExited(processIdentity{PID: os.Getpid(), Creation: "garbage"}); err == nil {
		t.Fatal("malformed process birth was accepted as death proof")
	}
	if _, err := recordedProcessExited(processIdentity{PID: -1, Creation: "1"}); err == nil {
		t.Fatal("invalid PID was accepted as death proof")
	}
}

func TestRecoveryPreservesChangedEvidence(t *testing.T) {
	config, client, _, recordRaw, journalRaw := recoveryOwner(t)
	killOwnedTestOwner(t, client)
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	journalPath := filepath.Join(directory, recoveryFileName)
	journal, _, err := readRecoveryJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	boot, err := currentBootID()
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	verify := func() error {
		calls++
		if calls == 2 {
			changed := journal
			changed.Phase = "pending"
			if err := writePrivateDocument(journalPath, changed); err != nil {
				return err
			}
		}
		return verifyRecoveryEvidence(journalPath, journal, journalRaw, boot)
	}
	if err := archiveRecovery(directory, recordRaw, journalRaw, verify); !errors.Is(err, ErrOwnerIdentityMismatch) {
		t.Fatalf("changed evidence was removed after archival: %v", err)
	}
	retained, err := os.ReadFile(filepath.Join(directory, recordFileName))
	if err != nil || !bytes.Equal(retained, recordRaw) {
		t.Fatal("CAS failure removed or relabeled the old owner")
	}
	current, _, err := readRecoveryJournal(journalPath)
	if err != nil || current.Phase != "pending" {
		t.Fatal("CAS failure replaced newer pending evidence")
	}
	entries, err := os.ReadDir(filepath.Join(directory, "archive"))
	if err != nil || len(entries) != 1 {
		t.Fatal("partial recovery discarded its archived forensic copy")
	}
	archived, _ := os.ReadFile(filepath.Join(directory, "archive", entries[0].Name(), recoveryFileName))
	if !bytes.Equal(archived, journalRaw) {
		t.Fatal("CAS failure changed the archived original bytes")
	}
}

func TestRecoveryArchivePublicationNeverOverwrites(t *testing.T) {
	config := ownerTestConfig(t)
	directory := filepath.Join(config.StateRoot, "private-archive")
	if err := privateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, recordFileName)
	first := []byte("original forensic bytes")
	if err := writeArchiveFile(path, first); err != nil {
		t.Fatal(err)
	}
	if err := writeArchiveFile(path, []byte("replacement")); !errors.Is(err, ErrOwnerRecordInvalid) {
		t.Fatalf("archive reused an existing destination: %v", err)
	}
	actual, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(actual, first) {
		t.Fatal("archive publication overwrote earlier evidence")
	}
}

func TestFreshOpenCannotWriteInsideHeldCleanupLifetime(t *testing.T) {
	config := ownerTestConfig(t)
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	if err := privateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	lease, err := localrpc.AcquireOwnerLock(context.Background(), directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err := Open(context.Background(), config); !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("fresh create ignored held lifetime: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(directory, recordFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cleanup overlap published a pending replacement")
	}
}

func TestOrphanJournalCannotBypassActivityFence(t *testing.T) {
	config, client, _, _, _ := recoveryOwner(t)
	killOwnedTestOwner(t, client)
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	journalPath := filepath.Join(directory, recoveryFileName)
	journal, _, err := readRecoveryJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	journal.Phase = "pending"
	journal.Containment = "" // An orphan cannot invent a missing containment contract.
	if err := writePrivateDocument(journalPath, journal); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(directory, recordFileName)); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(journalPath)
	if _, err := Open(context.Background(), config); !errors.Is(err, ErrOwnerRecordInvalid) {
		t.Fatalf("missing record bypassed orphan activity evidence: %v", err)
	}
	actual, _ := os.ReadFile(journalPath)
	if !bytes.Equal(actual, raw) {
		t.Fatal("unconfirmed orphan journal was replaced")
	}
	if _, err := os.Lstat(filepath.Join(directory, recordFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unconfirmed orphan journal created a new owner")
	}
}

func TestOrphanIdleJournalRecoversCleanupCrashWindow(t *testing.T) {
	config, client, _, _, raw := recoveryOwner(t)
	killOwnedTestOwner(t, client)
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	if err := os.Remove(filepath.Join(directory, recordFileName)); err != nil {
		t.Fatal(err)
	}
	owner, err := Open(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutdownOwner(t, owner) })
	if !owner.Created() {
		t.Fatal("idle cleanup crash did not create a new owner")
	}
	entries, err := os.ReadDir(filepath.Join(directory, "archive"))
	if err != nil || len(entries) != 1 {
		t.Fatal("orphan idle journal was not archived")
	}
	archived, _ := os.ReadFile(filepath.Join(directory, "archive", entries[0].Name(), recoveryFileName))
	if !bytes.Equal(raw, archived) {
		t.Fatal("orphan idle journal archive changed its bytes")
	}
}

func TestOwnerShutdownRetainsUnconfirmedLaunchFence(t *testing.T) {
	config := ownerTestConfig(t)
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	if err := privateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	record, err := configRecord(config)
	if err != nil {
		t.Fatal(err)
	}
	record.Instance = strings.Repeat("a", 32)
	record.Process, err = processIdentityAt(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	journal, err := newActivityJournal(directory, record)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.beforeStart("unconfirmed_subject"); err != nil {
		t.Fatal(err)
	}
	local := NewLocal()
	local.recovery = journal
	if err := local.Shutdown(context.Background()); !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("missing containment incorrectly completed shutdown: %v", err)
	}
	retained, _, err := readRecoveryJournal(journal.path)
	if err != nil || retained.Phase != "pending" || local.closed {
		t.Fatal("unconfirmed shutdown discarded pending activity evidence")
	}
}
