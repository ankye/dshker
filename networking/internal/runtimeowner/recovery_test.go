package runtimeowner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/localrpc"
)

func recoveryOwner(t *testing.T) (Config, *Client, ownerRecord, []byte, []byte) {
	t.Helper()
	config := ownerTestConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	path := filepath.Join(directory, recordFileName)
	record, err := readRecord(path)
	if err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(directory, recoveryFileName)
	waitOwner(t, "production owner did not publish its idle recovery journal", func() bool {
		journal, _, err := readRecoveryJournal(journalPath)
		return err == nil && journalMatchesRecord(journal, record) && journal.Phase == "idle"
	})
	raw, _ := os.ReadFile(path)
	journalRaw, _ := os.ReadFile(journalPath)
	t.Cleanup(func() {
		if record.SocketDirectory != "" {
			_ = os.Remove(record.Socket)
			_ = os.Remove(record.SocketDirectory)
		}
	})
	return config, client, record, raw, journalRaw
}

func killOwnedTestOwner(t *testing.T, client *Client) {
	t.Helper()
	expected := client.record.Process
	actual, err := processIdentityAt(expected.PID)
	if err != nil || actual != expected {
		t.Fatal("test owner identity changed before explicit test-process termination")
	}
	process, err := os.FindProcess(expected.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	if err := process.Kill(); err != nil {
		t.Fatal(err)
	}
	client.Close()
	waitOwner(t, "exact test owner did not exit", func() bool {
		if runtime.GOOS == "linux" {
			// A zombie thread-group leader can precede the final thread's
			// shared-file cleanup. Wait for reap or exact PID reuse before
			// preparing the next lease holder; do not retry its lock assertion.
			_, err := os.Stat(filepath.Join("/proc", strconv.Itoa(expected.PID)))
			if errors.Is(err, os.ErrNotExist) {
				return true
			}
			if err != nil {
				return false
			}
			actual, err := processIdentityAt(expected.PID)
			return err == nil && actual != expected
		}
		exited, err := recordedProcessExited(expected)
		return err == nil && exited
	})
}

func TestDeadIdleOwnerArchivesExactEvidenceAndRecoversOnce(t *testing.T) {
	config, first, record, raw, journalRaw := recoveryOwner(t)
	killOwnedTestOwner(t, first)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	recovered, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutdownOwner(t, recovered) })
	if !recovered.Created() || recovered.Identity() == first.Identity() || recovered.record.Instance == record.Instance {
		t.Fatal("recovery did not create one distinct empty owner after archiving")
	}
	archive := filepath.Join(config.StateRoot, ownerDirectory, "archive")
	generations, err := os.ReadDir(archive)
	if err != nil || len(generations) != 1 || !generations[0].IsDir() {
		t.Fatal("recovery did not retain exactly one private archive generation")
	}
	for name, expected := range map[string][]byte{recordFileName: raw, recoveryFileName: journalRaw} {
		path := filepath.Join(archive, generations[0].Name(), name)
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(actual, expected) || checkPrivatePath(path, false) != nil {
			t.Fatalf("archive did not preserve exact private %s bytes", name)
		}
	}
	attached, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer attached.Close()
	if attached.Created() || attached.Identity() != recovered.Identity() {
		t.Fatal("repeated recovery changed the newly authenticated owner")
	}
	if entries, _ := os.ReadDir(archive); len(entries) != 1 {
		t.Fatal("live reattachment archived the same owner twice")
	}
	if _, present, err := recovered.Status(ctx, "never_started"); err != nil || present {
		t.Fatal("recovered owner fabricated a child instead of admitting an empty runtime")
	}
}

func TestDeadActiveOwnerRecoversOnlyWithKernelContainment(t *testing.T) {
	config, first, _, _, _ := recoveryOwner(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	view, err := first.Start(ctx, childRequest(t, config.StateRoot, "subject_recovery_active"))
	if err != nil {
		t.Fatal(err)
	}
	child, err := processIdentityAt(view.PID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if actual, err := processIdentityAt(child.PID); err == nil && actual == child {
			process, err := os.FindProcess(child.PID)
			if err == nil {
				_ = process.Kill()
				_ = process.Release()
			}
		}
	})
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	recordRaw, _ := os.ReadFile(filepath.Join(directory, recordFileName))
	journalRaw, _ := os.ReadFile(filepath.Join(directory, recoveryFileName))
	killOwnedTestOwner(t, first)
	if runtime.GOOS == "windows" {
		waitOwner(t, "owner job did not terminate its exact child", func() bool { gone, err := recordedProcessExited(child); return err == nil && gone })
		replacement, err := Open(ctx, config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { shutdownOwner(t, replacement) })
		if !replacement.Created() || replacement.record.Instance == first.record.Instance {
			t.Fatal("kernel-contained death did not create a distinct owner")
		}
		return
	}
	if _, err := Open(ctx, config); !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("same-boot active owner was not refused: %v", err)
	}
	assertRecoveryBytes(t, directory, recordRaw, journalRaw)
	if actual, err := processIdentityAt(child.PID); err != nil || actual != child {
		t.Fatal("refusing recovery changed the still-live exact managed child")
	}
}

func assertRecoveryBytes(t *testing.T, directory string, recordRaw, journalRaw []byte) {
	t.Helper()
	for name, expected := range map[string][]byte{recordFileName: recordRaw, recoveryFileName: journalRaw} {
		actual, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("rejected recovery changed %s evidence", name)
		}
	}
	if _, err := os.Lstat(filepath.Join(directory, "archive")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("rejected recovery created an archive or started replacement ownership")
	}
}

func TestDeadOwnerRejectsUncertainRecoveryEvidence(t *testing.T) {
	for _, scenario := range []string{"pending", "active", "missing", "corrupt", "binding", "phase", "unknown_field"} {
		t.Run(scenario, func(t *testing.T) {
			config, client, _, _, _ := recoveryOwner(t)
			killOwnedTestOwner(t, client)
			directory := filepath.Join(config.StateRoot, ownerDirectory)
			path := filepath.Join(directory, recoveryFileName)
			journal, raw, err := readRecoveryJournal(path)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "pending", "active":
				journal.Phase = scenario
				if runtime.GOOS == "windows" {
					journal.Containment = ""
				} // Unproven legacy activity cannot borrow a job guarantee.
				if err := writePrivateDocument(path, journal); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "binding":
				journal.Owner.Instance = strings.Repeat("f", 32)
				if err := writePrivateDocument(path, journal); err != nil {
					t.Fatal(err)
				}
			case "phase":
				journal.Phase = "invented"
				if err := writePrivateDocument(path, journal); err != nil {
					t.Fatal(err)
				}
			case "unknown_field":
				raw = append([]byte(`{"unknown":true,`), raw[1:]...)
				if err := os.WriteFile(path, raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			recordRaw, _ := os.ReadFile(filepath.Join(directory, recordFileName))
			journalRaw, _ := os.ReadFile(path)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if replacement, err := Open(ctx, config); err == nil {
				shutdownOwner(t, replacement)
				t.Fatal("unconfirmed recovery evidence admitted a replacement owner")
			}
			actual, _ := os.ReadFile(filepath.Join(directory, recordFileName))
			if !bytes.Equal(actual, recordRaw) {
				t.Fatal("rejected evidence changed owner bytes")
			}
			actualJournal, _ := os.ReadFile(path)
			if !bytes.Equal(actualJournal, journalRaw) {
				t.Fatal("rejected evidence changed journal bytes")
			}
			if _, err := os.Lstat(filepath.Join(directory, "archive")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("unconfirmed evidence was archived")
			}
		})
	}
}

func TestRecoveryCannotArchiveUnderHeldLifetimeLease(t *testing.T) {
	config, client, _, recordRaw, journalRaw := recoveryOwner(t)
	killOwnedTestOwner(t, client)
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	lease, err := localrpc.AcquireOwnerLock(context.Background(), directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err := Open(context.Background(), config); !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("held lifetime lease did not prevent archival: %v", err)
	}
	assertRecoveryBytes(t, directory, recordRaw, journalRaw)
}

func TestOwnerExplicitStopPublishesIdleRecoveryEvidence(t *testing.T) {
	config, client, _, _, _ := recoveryOwner(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Cleanup(func() { shutdownOwner(t, client) })
	request := childRequest(t, config.StateRoot, "subject_recovery_stop")
	if _, err := client.Start(ctx, request); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(config.StateRoot, ownerDirectory, recoveryFileName)
	if journal, _, err := readRecoveryJournal(journalPath); err != nil || journal.Phase != "active" {
		t.Fatal("successful spawn did not persist active evidence")
	}
	if view, err := client.Stop(ctx, request.SubjectID); err != nil || view.State != harnessruntime.StateStopped {
		t.Fatalf("exact tree stop did not complete: %v", err)
	}
	if journal, _, err := readRecoveryJournal(journalPath); err != nil || journal.Phase != "idle" {
		t.Fatal("confirmed exact tree stop did not persist idle evidence")
	}
}
