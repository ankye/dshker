package runtimeowner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func createPendingOwner(ctx context.Context, directory string, expected ownerRecord) (record ownerRecord, failure error) {
	// Normal cleanup removes its evidence before releasing the lifetime lease.
	// An overlapping first Open must not publish into that still-held lifetime.
	lifetime, err := localrpc.AcquireOwnerLock(ctx, directory, false)
	if err != nil {
		return record, ErrOwnerUnavailable
	}
	defer func() {
		if err := lifetime.Release(); err != nil && failure == nil {
			failure = ErrOwnerUnavailable
		}
	}()
	if _, err := os.Lstat(filepath.Join(directory, recordFileName)); !errors.Is(err, os.ErrNotExist) {
		return record, ErrOwnerIdentityMismatch
	}
	if _, err := os.Lstat(filepath.Join(directory, recoveryFileName)); !errors.Is(err, os.ErrNotExist) {
		return record, ErrOwnerIdentityMismatch
	}
	record = expected
	if record.Instance, err = randomHex(16); err != nil {
		return record, err
	}
	if record.Token, err = randomHex(32); err != nil {
		return record, err
	}
	if record.Socket, record.SocketDirectory, err = ownerSocket(directory); err != nil {
		return record, err
	}
	if err := writeRecord(filepath.Join(directory, recordFileName), record); err != nil {
		return record, err
	}
	return record, nil
}

// recoverExitedOwner runs only while Open owns the creation lease. A dead PID
// alone is insufficient: the separate lifetime lease and durable activity
// evidence must agree, and an unknown process probe never grants recovery.
func recoverExitedOwner(ctx context.Context, directory string, expected, record ownerRecord) (bool, error) {
	exited, err := recordedProcessExited(record.Process)
	if err != nil || !exited {
		return false, nil // Let the ordinary authenticated attachment report failure.
	}
	journalPath := filepath.Join(directory, recoveryFileName)
	journal, journalRaw, err := readRecoveryJournal(journalPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, ErrOwnerUnavailable // Legacy state has no child-death proof.
		}
		return false, ErrOwnerRecordInvalid
	}
	if !journalMatchesRecord(journal, record) || !sameConfiguration(record, expected) {
		return false, ErrOwnerIdentityMismatch
	}
	boot, err := currentBootID()
	if err != nil {
		return false, ErrOwnerUnavailable
	}
	lifetime, err := localrpc.AcquireOwnerLock(ctx, directory, false)
	if err != nil {
		return false, ErrOwnerUnavailable
	}
	defer lifetime.Release()
	if err := awaitRecoverySafety(ctx, journal, boot); err != nil {
		return false, err
	}
	if err := validateRecoveryEndpoint(record, true); err != nil {
		return false, err
	}
	recordPath := filepath.Join(directory, recordFileName)
	recordRaw, err := readPrivateDocument(recordPath)
	if err != nil {
		return false, ErrOwnerRecordInvalid
	}
	verify := func() error {
		current, err := readRecord(recordPath)
		if err != nil || current != record {
			return ErrOwnerIdentityMismatch
		}
		currentRaw, err := readPrivateDocument(recordPath)
		if err != nil || !bytes.Equal(currentRaw, recordRaw) {
			return ErrOwnerIdentityMismatch
		}
		return verifyRecoveryEvidence(journalPath, journal, journalRaw, boot)
	}
	if err := archiveRecovery(directory, recordRaw, journalRaw, verify); err != nil {
		return false, err
	}
	return true, nil
}

// A normal cleanup can exit after removing owner.json but before removing its
// idle journal. Missing ownership must not bypass an active or unbound journal.
func recoverOrphanJournal(ctx context.Context, directory string, expected ownerRecord) error {
	path := filepath.Join(directory, recoveryFileName)
	journal, raw, err := readRecoveryJournal(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return ErrOwnerRecordInvalid
	}
	if journal.Owner.Config != expected.Config || journal.Owner.ExecutableSHA256 != expected.ExecutableHash || journal.Owner.RootsSHA256 != expected.RootsHash || journal.Home != expected.Home {
		return ErrOwnerIdentityMismatch
	}
	boot, err := currentBootID()
	if err != nil {
		return ErrOwnerUnavailable
	}
	lifetime, err := localrpc.AcquireOwnerLock(ctx, directory, false)
	if err != nil {
		return ErrOwnerUnavailable
	}
	defer lifetime.Release()
	if err := awaitRecoverySafety(ctx, journal, boot); err != nil {
		return err
	}
	verify := func() error {
		if _, err := os.Lstat(filepath.Join(directory, recordFileName)); !errors.Is(err, os.ErrNotExist) {
			return ErrOwnerIdentityMismatch
		}
		return verifyRecoveryEvidence(path, journal, raw, boot)
	}
	return archiveRecovery(directory, nil, raw, verify)
}

func verifyRecoveryEvidence(path string, expected recoveryJournal, raw []byte, boot string) error {
	current, currentRaw, err := readRecoveryJournal(path)
	if err != nil || current != expected || !bytes.Equal(raw, currentRaw) {
		return ErrOwnerIdentityMismatch
	}
	currentBoot, err := currentBootID()
	if err != nil || currentBoot != boot {
		return ErrOwnerUnavailable
	}
	exited, err := recordedProcessExited(processIdentity{PID: expected.Owner.PID, Creation: expected.Owner.Creation})
	if err != nil || !exited {
		return ErrOwnerUnavailable
	}
	if expected.BootID == boot {
		gone, err := recoveryContainmentGone(expected)
		if err != nil || !gone {
			return ErrOwnerUnavailable
		}
	}
	return nil
}

func awaitRecoverySafety(ctx context.Context, journal recoveryJournal, boot string) error {
	if journal.BootID != boot {
		return nil
	}
	for {
		gone, err := recoveryContainmentGone(journal)
		if err != nil {
			return err
		}
		if gone {
			return nil
		}
		// Unix active/pending has no owner-lifetime containment to wait for.
		if containmentKind != "windows-owner-job-v1" {
			return ErrOwnerUnavailable
		}
		select {
		case <-ctx.Done():
			return ErrOwnerUnavailable
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func archiveRecovery(directory string, recordRaw, journalRaw []byte, verify func() error) error {
	if err := verify(); err != nil {
		return err
	}
	archive := filepath.Join(directory, "archive")
	if err := privateDirectory(archive); err != nil {
		return err
	}
	suffix, err := randomHex(16)
	if err != nil {
		return err
	}
	generation := filepath.Join(archive, suffix)
	if err := createPrivateDirectory(generation); err != nil {
		return ErrOwnerRecordInvalid // No reuse or replacement of an earlier archive.
	}
	if err := checkPrivatePath(generation, true); err != nil {
		return err
	}
	for _, item := range []struct {
		name string
		raw  []byte
	}{{recordFileName, recordRaw}, {recoveryFileName, journalRaw}} {
		if item.raw != nil {
			if err := writeArchiveFile(filepath.Join(generation, item.name), item.raw); err != nil {
				return err // Partial archives never grant removal of source evidence.
			}
		}
	}
	if err := syncRecordDirectory(generation); err != nil {
		return err
	}
	if err := syncRecordDirectory(archive); err != nil {
		return err
	}
	if err := verify(); err != nil {
		return err
	}
	if recordRaw != nil {
		if err := os.Remove(filepath.Join(directory, recordFileName)); err != nil {
			return ErrOwnerRecordInvalid
		}
	}
	if err := os.Remove(filepath.Join(directory, recoveryFileName)); err != nil {
		return ErrOwnerRecordInvalid
	}
	return syncRecordDirectory(directory)
}

func writeArchiveFile(path string, raw []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrOwnerRecordInvalid
	}
	if err := secureCreatedPath(path, false); err != nil {
		file.Close()
		return err
	}
	_, writeErr := file.Write(raw)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return ErrOwnerRecordInvalid
	}
	return nil
}
