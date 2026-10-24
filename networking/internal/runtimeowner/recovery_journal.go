package runtimeowner

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ankye/dshker/networking/internal/protocol"
)

const recoveryFileName = "recovery.json"

// This document contains no endpoint credentials. An idle phase is a durable
// assertion that this owner has never spawned, or has joined, every child.
// Pending is persisted before spawn; an uncertain outcome never becomes idle.
type recoveryJournal struct {
	Version     int         `json:"version"`
	Owner       Identity    `json:"owner"`
	Home        homeContext `json:"home"`
	BootID      string      `json:"bootId"`
	Phase       string      `json:"phase"`
	Containment string      `json:"containment"`
}

type activityJournal struct {
	path      string
	value     recoveryJournal
	active    map[string]bool
	uncertain bool
}

type activityCheckpoint struct {
	phase     string
	active    bool
	uncertain bool
}

func newActivityJournal(directory string, record ownerRecord) (*activityJournal, error) {
	boot, err := currentBootID()
	if err != nil {
		return nil, err
	}
	journal := &activityJournal{
		path:   filepath.Join(directory, recoveryFileName),
		value:  recoveryJournal{Version: 1, Owner: publicIdentity(record), Home: record.Home, BootID: boot, Phase: "idle", Containment: containmentKind},
		active: map[string]bool{},
	}
	if err := journal.persist("idle"); err != nil {
		return nil, err
	}
	return journal, nil
}

func (journal *activityJournal) persist(phase string) error {
	next := journal.value
	next.Phase = phase
	if err := writePrivateDocument(journal.path, next); err != nil {
		return err
	}
	journal.value = next
	return nil
}

func (journal *activityJournal) beforeStart(subject string) (activityCheckpoint, error) {
	checkpoint := activityCheckpoint{journal.value.Phase, journal.active[subject], journal.uncertain}
	if journal.active[subject] {
		// A prior root exited without a confirmed tree join. A later successful
		// start/stop of the same subject cannot prove that earlier tree vanished.
		journal.uncertain = true
	}
	journal.active[subject] = true
	return checkpoint, journal.persist("pending")
}

// StartCommand reports an error only before a child has successfully started.
// Restore the previous proof for such a deterministic no-spawn rejection.
func (journal *activityJournal) abortStart(subject string, checkpoint activityCheckpoint) error {
	if err := journal.persist(checkpoint.phase); err != nil {
		return err
	}
	if checkpoint.active {
		journal.active[subject] = true
	} else {
		delete(journal.active, subject)
	}
	journal.uncertain = checkpoint.uncertain
	return nil
}

func (journal *activityJournal) afterStart() error { return journal.persist("active") }

func (journal *activityJournal) clean() bool {
	return journal.value.Phase == "idle" && len(journal.active) == 0 && !journal.uncertain
}

func (journal *activityJournal) confirmIdle() error {
	if err := journal.persist("idle"); err != nil {
		return err
	}
	journal.active = map[string]bool{}
	journal.uncertain = false
	return nil
}

func readPrivateDocument(path string) ([]byte, error) {
	file, err := openRecordFile(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxRecordBytes+1))
	if err != nil || len(raw) > maxRecordBytes {
		return nil, ErrOwnerRecordInvalid
	}
	return raw, nil
}

func readRecoveryJournal(path string) (recoveryJournal, []byte, error) {
	raw, err := readPrivateDocument(path)
	if err != nil {
		return recoveryJournal{}, nil, err
	}
	var journal recoveryJournal
	if protocol.DecodeExact(raw, &journal) != nil || journal.Version != 1 ||
		!hexValue(journal.BootID, 64) || !hexValue(journal.Owner.Instance, 32) ||
		!hexValue(journal.Owner.ExecutableSHA256, 64) || !hexValue(journal.Home.Digest, 64) ||
		(journal.Owner.RootsSHA256 != "" && !hexValue(journal.Owner.RootsSHA256, 64)) ||
		journal.Owner.Version != ProtocolVersion || !validRecordedProcess(processIdentity{journal.Owner.PID, journal.Owner.Creation}) || journal.Containment != containmentKind ||
		(journal.Phase != "idle" && journal.Phase != "pending" && journal.Phase != "active") {
		return recoveryJournal{}, nil, ErrOwnerRecordInvalid
	}
	return journal, raw, nil
}

func validRecordedProcess(identity processIdentity) bool {
	return identity.PID > 0 && uint64(identity.PID) <= maxRecordedPID && validProcessCreation(identity.Creation)
}

func journalMatchesRecord(journal recoveryJournal, record ownerRecord) bool {
	return journal.Owner == publicIdentity(record) && journal.Home == record.Home
}

func removeRecoveryJournal(path string, expected recoveryJournal) error {
	current, _, err := readRecoveryJournal(path)
	if err != nil || current != expected {
		return ErrOwnerIdentityMismatch
	}
	if os.Remove(path) != nil {
		return ErrOwnerRecordInvalid
	}
	return syncRecordDirectory(filepath.Dir(path))
}

func bootSessionDigest(identifier string) (string, error) {
	identifier = strings.ToLower(strings.TrimSpace(identifier))
	normalized := strings.ReplaceAll(identifier, "-", "")
	if !hexValue(normalized, 32) || normalized == strings.Repeat("0", 32) {
		return "", ErrOwnerUnavailable
	}
	digest := sha256.Sum256([]byte("dshker-boot/" + runtime.GOOS + "/" + normalized))
	return hex.EncodeToString(digest[:]), nil
}
