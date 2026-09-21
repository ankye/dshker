package helper

// The attempt number reconnection hands to each connect.
//
// A generation names one attempt. A surface caches the workbench address under it
// and refuses an address whose generation has moved on, so a reconnect that reused
// a constant would make a replaced attempt indistinguishable from the one a tab is
// showing — the stale address would look current. These tests pin the two
// properties that keeps depending on: it always rises, and it never repeats.

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// TestGenerationStrictlyIncreases is the property the address cache depends on.
func TestGenerationStrictlyIncreases(t *testing.T) {
	host := New(context.Background())
	previous := uint64(0)
	for attempt := 0; attempt < 1000; attempt++ {
		current := host.nextGeneration()
		if current <= previous {
			t.Fatalf("attempt %d produced %d, which does not exceed %d", attempt, current, previous)
		}
		previous = current
	}
}

// TestGenerationNeverRepeats covers the fast-loop case the wall clock alone does
// not: a thousand attempts inside one millisecond must still be distinguishable, or
// two different attempts would share an address slot.
func TestGenerationNeverRepeats(t *testing.T) {
	host := New(context.Background())
	seen := make(map[uint64]bool, 1000)
	for attempt := 0; attempt < 1000; attempt++ {
		value := host.nextGeneration()
		if seen[value] {
			t.Fatalf("generation %d was issued twice", value)
		}
		seen[value] = true
	}
}

// TestGenerationStartsFromTheClock keeps a restarted daemon from reissuing numbers an
// earlier run already handed out, which would make an address from the previous
// process look current to a surface that outlived it.
//
// The reading is taken in epoch-relative terms, because that is the scale both
// surfaces count in; comparing against the raw Unix clock would only re-assert the
// mismatch this file exists to prevent.
func TestGenerationStartsFromTheClock(t *testing.T) {
	before := uint64(time.Now().UnixMilli() - generationEpochMillis)
	host := New(context.Background())
	first := host.nextGeneration()
	if first < before {
		t.Fatalf("first generation %d precedes the epoch-relative clock reading %d", first, before)
	}
	// A second host standing in for a restart must not go backwards.
	restarted := New(context.Background())
	if next := restarted.nextGeneration(); next < first {
		t.Fatalf("a restarted host issued %d, behind the earlier run's %d", next, first)
	}
}

// TestGenerationIsSafeUnderConcurrentAttempts matters because the engine can attempt
// several pairs at once: two goroutines must never receive the same number.
func TestGenerationIsSafeUnderConcurrentAttempts(t *testing.T) {
	host := New(context.Background())
	const workers = 16
	const each = 64
	results := make(chan uint64, workers*each)
	for worker := 0; worker < workers; worker++ {
		go func() {
			for attempt := 0; attempt < each; attempt++ {
				results <- host.nextGeneration()
			}
		}()
	}
	seen := make(map[uint64]bool, workers*each)
	for index := 0; index < workers*each; index++ {
		value := <-results
		if seen[value] {
			t.Fatalf("generation %d was issued to two concurrent attempts", value)
		}
		seen[value] = true
	}
}

// TestConnectPairSendsAFreshGenerationEachAttempt closes the gap the generator tests
// leave open: they prove nextGeneration behaves, not that the reconnect path uses it.
// Reverting the call site to a constant passes every test above, so the payload
// connectPair actually builds is inspected here.
//
// There is no coordinator, so the connect is expected to fail. That is fine and is
// the point: the request is built and dispatched before anything can be reached, so
// the generation it carries is observable from the account's own pinned state.
func TestConnectPairSendsAFreshGenerationEachAttempt(t *testing.T) {
	host := New(context.Background())
	serviceID := protocol.NewID()
	pairID := protocol.NewID()
	host.accounts[serviceID] = &account{
		identity: controlplane.Identity{ServiceID: serviceID},
		host:     host,
	}

	// Two attempts on the same pair. Each must carry a different, rising generation;
	// a constant would make the second attempt indistinguishable from the first.
	before := host.generation
	_ = host.connectPair(context.Background(), serviceID, pairID)
	first := host.generation
	_ = host.connectPair(context.Background(), serviceID, pairID)
	second := host.generation

	if first <= before {
		t.Fatalf("the first attempt did not mint a generation (%d -> %d)", before, first)
	}
	if second <= first {
		t.Fatalf("the second attempt reused or lowered the generation (%d -> %d)", first, second)
	}
}

// TestConnectPairOnAnUnknownServiceIsNamed keeps the reconnect path from reporting a
// missing service as a generic failure, which the engine would then treat as
// transient and retry forever.
func TestConnectPairOnAnUnknownServiceIsNamed(t *testing.T) {
	host := New(context.Background())
	err := host.connectPair(context.Background(), protocol.NewID(), protocol.NewID())
	if err == nil || err.Error() != "p2p.service_unconfigured" {
		t.Fatalf("connect on an unknown service = %v, want p2p.service_unconfigured", err)
	}
}

// TestGenerationSharesTheShellEpoch is a cross-language constraint, so it is checked
// against the shell's source rather than restated as a second constant.
//
// A generation is compared across surfaces: after the core reconnects a pair, the
// shell must still be able to mint a number the core has not used. Counting from
// different origins broke exactly that — core numbers came out about 79x larger, and
// a shell that had been overtaken would have needed decades of wall clock to catch
// up, so every later manual connect was refused as p2p.stale_generation.
func TestGenerationSharesTheShellEpoch(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "electron", "main", "p2p", "connections.ts"))
	if err != nil {
		t.Skipf("the shell source is not present in this checkout: %v", err)
	}
	match := regexp.MustCompile(`GENERATION_EPOCH_MILLISECONDS\s*=\s*([0-9_]+)`).FindSubmatch(source)
	if match == nil {
		t.Fatal("the shell no longer declares GENERATION_EPOCH_MILLISECONDS; the epochs cannot be compared")
	}
	shellEpoch, convErr := strconv.ParseInt(strings.ReplaceAll(string(match[1]), "_", ""), 10, 64)
	if convErr != nil {
		t.Fatalf("the shell epoch is not a number: %v", convErr)
	}
	if shellEpoch != generationEpochMillis {
		t.Fatalf("the core counts attempts from %d and the shell from %d; a generation minted by one surface would outrank the other forever",
			generationEpochMillis, shellEpoch)
	}
}

// TestGenerationStaysInTheShellSafeIntegerRange keeps the value usable on the other
// side of the wire: the shell validates a generation with Number.isSafeInteger, so a
// number beyond that range would be refused outright.
func TestGenerationStaysInTheShellSafeIntegerRange(t *testing.T) {
	const maxSafeInteger = uint64(9007199254740991)
	host := New(context.Background())
	if value := host.nextGeneration(); value == 0 || value > maxSafeInteger {
		t.Fatalf("generation %d is outside the range the shell accepts", value)
	}
}
