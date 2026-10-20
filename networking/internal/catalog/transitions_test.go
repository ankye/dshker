package catalog

import (
	"bytes"
	"errors"
	"os"
	"sync"
	"testing"
)

func atomicSelectionSteps(t *testing.T) (*Store, Snapshot, []Record) {
	t.Helper()
	store := openStore(t)
	empty, err := store.Enable()
	if err != nil {
		t.Fatal(err)
	}
	service := newService(t, "atomic catalog")
	computer := newComputer(t, service)
	base := empty.Record
	base.Services, base.Computers = []Service{service}, []Computer{computer}
	saved, err := store.Commit(empty.Revision, base)
	if err != nil {
		t.Fatal(err)
	}
	revoked := base
	revoked.Computers = append([]Computer(nil), base.Computers...)
	revoked.Computers[0].PairState = "revoked"
	dropped := base
	dropped.Computers = []Computer{}
	fresh := base
	fresh.Computers = append([]Computer(nil), base.Computers...)
	fresh.Computers[0].NetworkID, fresh.Computers[0].UserID = randomID(t), randomID(t)
	return store, saved, []Record{revoked, dropped, fresh}
}

func TestCommitTransitionsPublishesOnlyValidatedFinalScope(t *testing.T) {
	store, saved, steps := atomicSelectionSteps(t)
	if _, err := store.Commit(saved.Revision, steps[2]); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatal("ordinary immutable transition guard was weakened", err)
	}
	committed, err := store.CommitTransitions(saved.Revision, steps)
	if err != nil || len(committed.Record.Computers) != 1 || committed.Record.Computers[0] != steps[2].Computers[0] {
		t.Fatal("atomic strict transitions did not publish the exact final scope", committed, err)
	}
	if _, err := store.CommitTransitions(saved.Revision, steps); !errors.Is(err, ErrConflict) {
		t.Fatal("old CAS revision committed twice", err)
	}
}

func TestCommitTransitionsInvalidMiddleAndThirdStepLeaveOriginalBytes(t *testing.T) {
	for _, kind := range []string{"empty", "too-many", "middle-revival", "third-invalid"} {
		t.Run(kind, func(t *testing.T) {
			store, saved, steps := atomicSelectionSteps(t)
			before, err := os.ReadFile(store.path(recordFile))
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "empty":
				steps = nil
			case "too-many":
				steps = make([]Record, 9)
			case "middle-revival":
				steps[1] = saved.Record
			case "third-invalid":
				steps[2].Computers[0].PairState = "pending"
			}
			if _, err := store.CommitTransitions(saved.Revision, steps); err == nil {
				t.Fatal("invalid transition sequence published")
			}
			after, err := os.ReadFile(store.path(recordFile))
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("failed later step left a durable intermediate drop", err)
			}
			current, err := store.Inspect()
			if err != nil || current.Revision != saved.Revision {
				t.Fatal("failed transaction moved the catalog revision", err)
			}
		})
	}
}

func TestCommitTransitionsConcurrentDifferentChoicesShareOneCAS(t *testing.T) {
	store, saved, first := atomicSelectionSteps(t)
	second := append([]Record(nil), first...)
	second[2].Computers = append([]Computer(nil), first[2].Computers...)
	second[2].Computers[0].NetworkID = randomID(t)
	var group sync.WaitGroup
	results := make(chan error, 2)
	for _, steps := range [][]Record{first, second} {
		group.Add(1)
		go func() { defer group.Done(); _, err := store.CommitTransitions(saved.Revision, steps); results <- err }()
	}
	group.Wait()
	close(results)
	var success, conflict int
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("concurrent transition sequences both published", success, conflict)
	}
}

func TestCommitTransitionsWriteFailureKeepsOriginalBytesAndRevision(t *testing.T) {
	store, saved, steps := atomicSelectionSteps(t)
	before, err := os.ReadFile(store.path(recordFile))
	if err != nil {
		t.Fatal(err)
	}
	restore := denyCatalogReplacement(t, store)
	_, err = store.CommitTransitions(saved.Revision, steps)
	restore()
	if !errors.Is(err, ErrWriteFailed) {
		t.Fatal("real publication failure was not typed", err)
	}
	after, err := os.ReadFile(store.path(recordFile))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("write failure destroyed prior exact lineage", err)
	}
	current, err := store.Inspect()
	if err != nil || current.Revision != saved.Revision {
		t.Fatal("write failure advanced the revision", err)
	}
}
