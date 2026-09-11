package secret

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
)

// TestStressConcurrentStoreOperations runs concurrent Set/Get cycles over one
// store. Windows rewrites the whole blob file per write, so this also proves
// the atomic rename keeps every reader seeing a complete store; macOS funnels
// the same load through the Keychain.
func TestStressConcurrentStoreOperations(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const workers = 8
	const rounds = 20
	expected := make([][]byte, workers)
	for worker := 0; worker < workers; worker++ {
		expected[worker] = []byte(fmt.Sprintf("stress-secret-%d", worker))
	}
	var wg sync.WaitGroup
	failures := make(chan error, workers*rounds)
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			key := fmt.Sprintf("key.%d", worker)
			value := expected[worker]
			for round := 0; round < rounds; round++ {
				if err = store.Set(key, value); err != nil {
					failures <- fmt.Errorf("worker %d set %d: %w", worker, round, err)
					return
				}
				got, err := store.Get(key)
				if err != nil {
					failures <- fmt.Errorf("worker %d get %d: %w", worker, round, err)
					return
				}
				if !bytes.Equal(got, value) {
					failures <- fmt.Errorf("worker %d round %d: mismatch", worker, round)
					return
				}
			}
		}(worker)
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	for worker := 0; worker < workers; worker++ {
		got, err := store.Get(fmt.Sprintf("key.%d", worker))
		if err != nil || !bytes.Equal(got, expected[worker]) {
			t.Errorf("final key %d: %v", worker, err)
		}
	}
	if err = store.Set("post", []byte("ok")); err != nil {
		t.Errorf("store unusable after stress: %v", err)
	}
}
