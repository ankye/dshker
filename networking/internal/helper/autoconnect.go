package helper

// The host half of reconnection: it supplies the engine with this machine's real
// intents, stages, and connect path.
//
// The engine itself is policy (which delay, which refusal stops trying); this file
// is the wiring that makes the policy act on a real host. Keeping them apart is
// what lets the schedule be tested without a coordinator, and lets the same engine
// serve a desktop shell and a headless daemon without either owning a private copy.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/ankye/dshker/networking/internal/autoconnect"
)

// AutoConnect keeps every catalog-authorized pair connected for this host.
//
// Nil-safe by construction: a host with no catalog has no recorded intent, so the
// engine simply finds nothing to do rather than the caller having to decide whether
// to start it.
func (host *Host) newAutoConnect() *autoconnect.Engine {
	return autoconnect.New(autoconnect.Options{
		Intents: func(context.Context) ([]autoconnect.Intent, error) {
			return host.authorizedPairs()
		},
		Stage:   host.pairStage,
		Connect: host.connectPair,
		CodeOf: func(err error) string {
			// The product's errors already are their public code, which is what the
			// terminal set is expressed in.
			if err == nil {
				return ""
			}
			return err.Error()
		},
	})
}

// authorizedPairs reads the intent from the catalog: an active pair should be
// connected. A revoked or pending one is not an intent and is left alone.
func (host *Host) authorizedPairs() ([]autoconnect.Intent, error) {
	host.mu.Lock()
	store := host.catalog
	host.mu.Unlock()
	if store == nil {
		// No catalog on this host: nothing is authorized, which is not a failure.
		return nil, nil
	}
	snapshot, err := store.Inspect()
	if err != nil {
		return nil, err
	}
	if snapshot == nil {
		return nil, nil
	}
	intents := make([]autoconnect.Intent, 0, len(snapshot.Record.Computers))
	for _, computer := range snapshot.Record.Computers {
		if computer.PairState != "active" {
			continue
		}
		intents = append(intents, autoconnect.Intent{
			ServiceID: computer.ServiceID,
			PairID:    computer.PairID,
		})
	}
	return intents, nil
}

// pairStage reports the live stage for one pair, or "" when this host has no
// session for it. An unknown stage is treated as "not connected", which is the
// conservative answer: attempting a pair that is already up is refused by the
// session manager, while skipping one that is down would strand it.
func (host *Host) pairStage(serviceID string, pairID string) string {
	host.mu.Lock()
	account := host.accounts[serviceID]
	host.mu.Unlock()
	if account == nil {
		return ""
	}
	account.mu.Lock()
	defer account.mu.Unlock()
	return account.stages[pairID]
}

// connectPair opens one session through exactly the path a caller uses, so the
// refusal codes the engine classifies are the product's own and not a second
// interpretation of them.
func (host *Host) connectPair(ctx context.Context, serviceID string, pairID string) error {
	host.mu.Lock()
	account := host.accounts[serviceID]
	host.mu.Unlock()
	if account == nil {
		return errors.New("p2p.service_unconfigured")
	}
	// A fresh generation per attempt, never a constant.
	//
	// The generation names one attempt. A surface caches the workbench address under
	// it and refuses an address whose generation has moved on, so reconnecting with a
	// fixed value would leave a replaced attempt indistinguishable from the one being
	// held — the stale address would look current and a tab would load a gateway the
	// new attempt does not own. Monotonic per host, and started from the wall clock so
	// it keeps rising across restarts rather than colliding with the numbers a
	// previous run already handed out.
	payload, err := json.Marshal(struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}{pairID, host.nextGeneration()})
	if err != nil {
		return errors.New("p2p.invalid_request")
	}
	_, callErr := account.connection(ctx, "peer.connect", payload)
	return callErr
}

// AutoConnectEngine returns this host's reconnection engine, creating it on first
// use.
//
// One engine per host, not one per caller: the schedule and the recorded terminal
// refusals are per-machine state, so a shell that reconciles and a daemon sweep must
// drive the same instance or the backoff would be duplicated.
func (host *Host) AutoConnectEngine() *autoconnect.Engine {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.reconnect == nil {
		host.reconnect = host.newAutoConnect()
	}
	return host.reconnect
}

// autoConnectOperation answers the three engine methods the shell drives.
//
// The shell no longer owns a reconnection implementation; it reports the events it
// uniquely observes (a stage that dropped, a catalog revision that landed) and the
// core decides what they mean.
func (host *Host) autoConnectOperation(ctx context.Context, method string) (any, error) {
	engine := host.AutoConnectEngine()
	switch method {
	case "peer.autoconnect_clear_refusals":
		engine.ClearRefusals()
	case "peer.autoconnect_retry_now":
		engine.RetryNow(ctx)
		return struct{}{}, nil
	}
	engine.Reconcile(ctx)
	return struct{}{}, nil
}

// generationEpochMillis is the origin every surface counts attempts from.
//
// It must equal GENERATION_EPOCH_MILLISECONDS in the shell's connections.ts. A
// generation is compared across surfaces — a shell that reconnects after the core
// did has to be able to mint a number the core has not already used — so the two
// have to count from the same instant. Seeding from the raw Unix clock instead put
// core-issued numbers about 79x higher than shell-issued ones, and once the core had
// reconnected a pair the shell could not catch up for decades: every later manual
// connect looked older than the attempt on record and was refused as
// p2p.stale_generation.
const generationEpochMillis = 1_767_225_600_000

// nextGeneration mints the next attempt number for this host.
//
// Strictly increasing, and seeded from the shared epoch so a restarted daemon does
// not reissue numbers an earlier run already used.
func (host *Host) nextGeneration() uint64 {
	host.mu.Lock()
	defer host.mu.Unlock()
	seeded := uint64(1)
	if now := time.Now().UnixMilli(); now > generationEpochMillis {
		seeded = uint64(now - generationEpochMillis)
	}
	if seeded <= host.generation {
		seeded = host.generation + 1
	}
	host.generation = seeded
	return host.generation
}
