package catalog

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInspectBeforeEnableReportsNothingStored(t *testing.T) {
	store := openStore(t)
	snapshot, err := store.Inspect()
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if snapshot != nil {
		t.Fatalf("a directory that was never enabled reported %+v", snapshot)
	}
}

func TestEnableCreatesTheCatalogOnce(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if len(enabled.Record.Services) != 0 || len(enabled.Record.Computers) != 0 || len(enabled.Record.ForgottenServiceIDs) != 0 {
		t.Fatalf("a fresh catalog is not empty: %+v", enabled.Record)
	}
	if enabled.Record.CatalogID == "" || enabled.Revision == "" {
		t.Fatalf("a fresh catalog has no identity: %+v", enabled)
	}

	if _, err := store.Enable(); !errors.Is(err, ErrExists) {
		t.Fatalf("a second enable = %v, want %v", err, ErrExists)
	}
	inspected, err := store.Inspect()
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspected.Record.CatalogID != enabled.Record.CatalogID {
		t.Fatal("a refused second enable changed the catalog identity")
	}
}

// Half a catalog is corruption, never an implicit reset: rewriting the missing
// half would silently discard whatever the user had.
func TestInspectRefusesAHalfWrittenCatalog(t *testing.T) {
	for _, missing := range []string{recordFile, markerFile} {
		store := openStore(t)
		if _, err := store.Enable(); err != nil {
			t.Fatalf("enable: %v", err)
		}
		if err := os.Remove(store.path(missing)); err != nil {
			t.Fatalf("remove %s: %v", missing, err)
		}
		if _, err := store.Inspect(); !errors.Is(err, ErrIncomplete) {
			t.Fatalf("without %s = %v, want %v", missing, err, ErrIncomplete)
		}
	}
}

// The revision is the hash the shell computes too, so the two implementations
// agree on what "unchanged" means.
func TestRevisionIsTheHashOfTheStoredBytes(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	raw, err := os.ReadFile(store.path(recordFile))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	digest := sha256.Sum256(raw)
	if enabled.Revision != hex.EncodeToString(digest[:]) {
		t.Fatalf("revision %s is not the hash of the stored bytes", enabled.Revision)
	}
}

func TestOpenRefusesUnusableDirectories(t *testing.T) {
	if _, err := Open("relative/path"); !errors.Is(err, ErrSettingsRoot) {
		t.Fatalf("relative directory = %v, want %v", err, ErrSettingsRoot)
	}
	if _, err := Open(filepath.Join(t.TempDir(), "absent")); !errors.Is(err, ErrSettingsRoot) {
		t.Fatalf("absent directory = %v, want %v", err, ErrSettingsRoot)
	}
	file := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Open(file); !errors.Is(err, ErrSettingsRoot) {
		t.Fatalf("a file as directory = %v, want %v", err, ErrSettingsRoot)
	}
}

func TestCommitRequiresTheCurrentRevision(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	next := enabled.Record
	next.Services = []Service{newService(t, "Coordinator")}

	if _, err := store.Commit("deadbeef", next); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision = %v, want %v", err, ErrConflict)
	}
	committed, err := store.Commit(enabled.Revision, next)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if committed.Revision == enabled.Revision || len(committed.Record.Services) != 1 {
		t.Fatalf("commit did not take effect: %+v", committed)
	}
	inspected, err := store.Inspect()
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if inspected.Revision != committed.Revision {
		t.Fatal("the committed revision is not the one on disk")
	}
}

// A redundant commit must not churn the file or its revision: the shell treats
// the revision as its concurrency token.
func TestCommitWithoutChangeKeepsTheRevision(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	same, err := store.Commit(enabled.Revision, enabled.Record)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if same.Revision != enabled.Revision {
		t.Fatalf("an unchanged commit moved the revision %s -> %s", enabled.Revision, same.Revision)
	}
}

// Identity continuity is enforced in persistence, so a mistaken workflow cannot
// replace a trusted key or quietly drop a pair.
func TestCommitEnforcesIdentityContinuity(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	service := newService(t, "Coordinator")
	withService := enabled.Record
	withService.Services = []Service{service}
	added, err := store.Commit(enabled.Revision, withService)
	if err != nil {
		t.Fatalf("add service: %v", err)
	}

	// A different key under the same service id cannot even be expressed: the id is
	// derived from the key, so the strict parser refuses the record first. The rule
	// itself is covered directly by the transition tests.

	// Dropping a service is only allowed once it has been forgotten.
	dropped := added.Record
	dropped.Services = []Service{}
	dropped.Computers = []Computer{}
	if _, err := store.Commit(added.Revision, dropped); !errors.Is(err, ErrForgetRequired) {
		t.Fatalf("silent removal = %v, want %v", err, ErrForgetRequired)
	}

	// Forgetting comes first, and the removal follows in a later write: the rule
	// compares against the previous forgotten set. The shell's removal path does
	// both in one write on purpose, which is exactly why it bypasses this check.
	forgetting := added.Record
	forgetting.ForgottenServiceIDs = []string{service.ServiceID}
	afterForget, err := store.Commit(added.Revision, forgetting)
	if err != nil {
		t.Fatalf("forget: %v", err)
	}
	removed := forgetting
	removed.Services = []Service{}
	removed.Computers = []Computer{}
	afterRemove, err := store.Commit(afterForget.Revision, removed)
	if err != nil {
		t.Fatalf("removing after forgetting: %v", err)
	}
	if len(afterRemove.Record.Services) != 0 {
		t.Fatalf("the service was not removed: %+v", afterRemove.Record.Services)
	}

	// A forgotten identity cannot come back.
	revived := afterRemove.Record
	revived.Services = []Service{service}
	if _, err := store.Commit(afterRemove.Revision, revived); err == nil {
		t.Fatal("a forgotten service was restored")
	}
}

func TestCommitRefusesAChangedCatalogIdentity(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	next := enabled.Record
	next.CatalogID = randomID(t)
	if _, err := store.Commit(enabled.Revision, next); !errors.Is(err, ErrConflict) {
		t.Fatalf("identity change = %v, want %v", err, ErrConflict)
	}
}

func TestRemoveServiceForgetsTheServiceAndItsComputers(t *testing.T) {
	store := openStore(t)
	enabled, err := store.Enable()
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	service, other := newService(t, "Coordinator"), newService(t, "Second")
	withBoth := enabled.Record
	withBoth.Services = []Service{service, other}
	withBoth.Computers = []Computer{newComputer(t, service), newComputer(t, other)}
	if _, err := store.Commit(enabled.Revision, withBoth); err != nil {
		t.Fatalf("commit: %v", err)
	}

	removed, err := store.RemoveService(service.ServiceID)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(removed.Record.Services) != 1 || removed.Record.Services[0].ServiceID != other.ServiceID {
		t.Fatalf("wrong service survived: %+v", removed.Record.Services)
	}
	if len(removed.Record.Computers) != 1 || removed.Record.Computers[0].ServiceID != other.ServiceID {
		t.Fatalf("the removed service kept a computer: %+v", removed.Record.Computers)
	}
	if len(removed.Record.ForgottenServiceIDs) != 1 || removed.Record.ForgottenServiceIDs[0] != service.ServiceID {
		t.Fatalf("the identity was not forgotten: %+v", removed.Record.ForgottenServiceIDs)
	}
	if _, err := store.Inspect(); err != nil {
		t.Fatalf("the file is unreadable after removal: %v", err)
	}

	if _, err := store.RemoveService(service.ServiceID); !errors.Is(err, ErrTrustRestore) {
		t.Fatalf("removing twice = %v, want %v", err, ErrTrustRestore)
	}
	if _, err := store.RemoveService(randomID(t)); !errors.Is(err, ErrServiceNotFound) {
		t.Fatalf("removing an absent service = %v, want %v", err, ErrServiceNotFound)
	}
}

// Deletion must not be blocked by a record that no longer passes strict
// validation, but what it writes has to be readable again.
func TestRemoveServiceStillWorksWhenTheRecordFailsStrictValidation(t *testing.T) {
	store := openStore(t)
	if _, err := store.Enable(); err != nil {
		t.Fatalf("enable: %v", err)
	}
	broken, healthy := newService(t, "Broken"), newService(t, "Healthy")
	broken.Certificate = base64.StdEncoding.EncodeToString([]byte("not a certificate"))
	record, err := store.Inspect()
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	next := record.Record
	next.Services = []Service{broken, healthy}
	raw, err := json.Marshal(next)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, err := Parse(raw); err == nil {
		t.Fatal("the strict parser accepted the broken certificate")
	}
	if err := os.WriteFile(store.path(recordFile), raw, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	removed, err := store.RemoveService(broken.ServiceID)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(removed.Record.Services) != 1 || removed.Record.Services[0].ServiceID != healthy.ServiceID {
		t.Fatalf("wrong service survived: %+v", removed.Record.Services)
	}
	if _, err := store.Inspect(); err != nil {
		t.Fatalf("the file is unreadable after removal: %v", err)
	}
}

func TestStoredFilesAreNotWorldReadable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows provider expresses access through a descriptor, not a mode")
	}
	store := openStore(t)
	if _, err := store.Enable(); err != nil {
		t.Fatalf("enable: %v", err)
	}
	for _, name := range []string{recordFile, markerFile} {
		info, err := os.Stat(store.path(name))
		if err != nil {
			t.Fatalf("stat %s: %v", name, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %v, want 0600", name, info.Mode().Perm())
		}
	}
}
