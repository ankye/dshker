package catalog

import (
	"errors"
	"testing"
)

// transitionRecord is the minimum AssertTransition looks at. The rules are about
// identity continuity, so they are exercised directly rather than through Commit,
// which cannot express some of these states at all (a service id is derived from
// its key, so the parser refuses a key change before the rule is reached).
func transitionRecord(services []Service, computers []Computer, forgotten []string) Record {
	return Record{
		Format:              recordFormat,
		Version:             1,
		CatalogID:           "000000000000",
		Services:            services,
		Computers:           computers,
		ForgottenServiceIDs: forgotten,
	}
}

func transitionService(id, key string) Service {
	return Service{
		ServiceID:   id,
		DisplayName: "Coordinator",
		HTTPSOrigin: "https://coordinator.example:8443",
		WSSURL:      "wss://coordinator.example:8443/v1/signals",
		STUNAddress: "coordinator.example:3478",
		PublicKey:   key,
		Certificate: "certificate",
	}
}

func transitionComputer(connectionID, serviceID, state string, revision int64) Computer {
	return Computer{
		ConnectionID:    connectionID,
		ServiceID:       serviceID,
		DisplayName:     "Work computer",
		PairID:          "111111111111",
		NetworkID:       "222222222222",
		LocalDeviceID:   "333333333333",
		RemoteDeviceID:  "444444444444",
		UserID:          "555555555555",
		LocalPublicKey:  "local-key",
		RemotePublicKey: "remote-key",
		PairRevision:    revision,
		PairState:       state,
	}
}

const (
	firstService  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	secondService = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	firstConn     = "cccccccccccc"
)

func TestTransitionAcceptsGrowth(t *testing.T) {
	empty := transitionRecord([]Service{}, []Computer{}, []string{})
	grown := transitionRecord(
		[]Service{transitionService(firstService, "key")},
		[]Computer{transitionComputer(firstConn, firstService, "active", 1)},
		[]string{},
	)
	if err := AssertTransition(empty, grown); err != nil {
		t.Fatalf("adding a service and its computer: %v", err)
	}
	if err := AssertTransition(grown, grown); err != nil {
		t.Fatalf("an unchanged record: %v", err)
	}
}

func TestTransitionRefusesRestoringAForgottenIdentity(t *testing.T) {
	forgotten := transitionRecord(nil, nil, []string{firstService})

	// Dropping the memory would make the identity restorable.
	if err := AssertTransition(forgotten, transitionRecord(nil, nil, nil)); !errors.Is(err, ErrTrustRestore) {
		t.Fatalf("forgetting a forgotten id = %v, want %v", err, ErrTrustRestore)
	}

	// Recreating it with different content is the actual restore.
	revived := transitionRecord([]Service{transitionService(firstService, "key")}, nil, []string{firstService})
	if err := AssertTransition(forgotten, revived); !errors.Is(err, ErrTrustRestore) {
		t.Fatalf("restoring with new content = %v, want %v", err, ErrTrustRestore)
	}

	// Keeping it identical is how removal is written, and stays allowed.
	same := transitionRecord(nil, nil, []string{firstService})
	if err := AssertTransition(forgotten, same); err != nil {
		t.Fatalf("an unchanged forgotten set: %v", err)
	}
}

func TestTransitionRefusesAReplacedServiceKey(t *testing.T) {
	previous := transitionRecord([]Service{transitionService(firstService, "original")}, nil, nil)
	replaced := transitionRecord([]Service{transitionService(firstService, "replacement")}, nil, nil)
	if err := AssertTransition(previous, replaced); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("key replacement = %v, want %v", err, ErrIdentityMismatch)
	}
}

func TestTransitionRefusesASilentServiceRemoval(t *testing.T) {
	previous := transitionRecord([]Service{transitionService(firstService, "key")}, nil, nil)
	// One write that both forgets and removes is refused, because the rule compares
	// against the *previous* forgotten set. Removal follows forgetting.
	if err := AssertTransition(previous, transitionRecord(nil, nil, []string{firstService})); !errors.Is(err, ErrForgetRequired) {
		t.Fatalf("removal without forgetting = %v, want %v", err, ErrForgetRequired)
	}
	// The sanctioned sequence: forget it while it is still present...
	forgetting := transitionRecord([]Service{transitionService(firstService, "key")}, nil, []string{firstService})
	if err := AssertTransition(previous, forgetting); err != nil {
		t.Fatalf("forgetting: %v", err)
	}
	// ...then drop it.
	if err := AssertTransition(forgetting, transitionRecord(nil, nil, []string{firstService})); err != nil {
		t.Fatalf("removal after forgetting: %v", err)
	}
}

func TestTransitionRefusesAChangedComputerIdentity(t *testing.T) {
	base := transitionComputer(firstConn, firstService, "active", 1)
	services := []Service{transitionService(firstService, "key")}
	previous := transitionRecord(services, []Computer{base}, nil)

	fields := map[string]func(*Computer){
		"service":      func(c *Computer) { c.ServiceID = secondService },
		"pair":         func(c *Computer) { c.PairID = "999999999999" },
		"network":      func(c *Computer) { c.NetworkID = "999999999999" },
		"local device": func(c *Computer) { c.LocalDeviceID = "999999999999" },
		"peer device":  func(c *Computer) { c.RemoteDeviceID = "999999999999" },
		"user":         func(c *Computer) { c.UserID = "999999999999" },
		"local key":    func(c *Computer) { c.LocalPublicKey = "other" },
		"peer key":     func(c *Computer) { c.RemotePublicKey = "other" },
	}
	for name, mutate := range fields {
		t.Run(name, func(t *testing.T) {
			changed := base
			mutate(&changed)
			next := transitionRecord(services, []Computer{changed}, nil)
			if err := AssertTransition(previous, next); !errors.Is(err, ErrIdentityMismatch) {
				t.Fatalf("%s change = %v, want %v", name, err, ErrIdentityMismatch)
			}
		})
	}
}

func TestTransitionRefusesARewoundOrRevivedPair(t *testing.T) {
	services := []Service{transitionService(firstService, "key")}
	active := transitionComputer(firstConn, firstService, "active", 2)
	previous := transitionRecord(services, []Computer{active}, nil)

	rewound := active
	rewound.PairRevision = 1
	if err := AssertTransition(previous, transitionRecord(services, []Computer{rewound}, nil)); !errors.Is(err, ErrTrustRestore) {
		t.Fatalf("a rewound revision = %v, want %v", err, ErrTrustRestore)
	}

	revoked := active
	revoked.PairState = "revoked"
	afterRevoke := transitionRecord(services, []Computer{revoked}, nil)
	if err := AssertTransition(previous, afterRevoke); err != nil {
		t.Fatalf("revoking: %v", err)
	}
	if err := AssertTransition(afterRevoke, previous); !errors.Is(err, ErrTrustRestore) {
		t.Fatalf("reviving a revoked pair = %v, want %v", err, ErrTrustRestore)
	}

	// A higher revision on a still-active pair is a normal update.
	forward := active
	forward.PairRevision = 3
	if err := AssertTransition(previous, transitionRecord(services, []Computer{forward}, nil)); err != nil {
		t.Fatalf("advancing a revision: %v", err)
	}

	// A revoked connection is retired before a re-authorization can be recorded,
	// because this guard refuses to revive one at all — including at a newer
	// revision, since a fresh pairing numbers its revision from the start. The
	// shell performs that retirement as its own commit; see recordMembers.
	repaired := revoked
	repaired.PairState = "active"
	repaired.PairRevision = 3
	if err := AssertTransition(afterRevoke, transitionRecord(services, []Computer{repaired}, nil)); !errors.Is(err, ErrTrustRestore) {
		t.Fatalf("reviving a revoked pair at a newer revision = %v, want %v", err, ErrTrustRestore)
	}
	if err := AssertTransition(afterRevoke, transitionRecord(services, nil, nil)); err != nil {
		t.Fatalf("retiring a revoked pair: %v", err)
	}
	if err := AssertTransition(transitionRecord(services, nil, nil), transitionRecord(services, []Computer{repaired}, nil)); err != nil {
		t.Fatalf("recording a re-authorized pair after retirement: %v", err)
	}
}

func TestTransitionRefusesASilentPairRemoval(t *testing.T) {
	services := []Service{transitionService(firstService, "key")}
	active := transitionComputer(firstConn, firstService, "active", 1)
	previous := transitionRecord(services, []Computer{active}, nil)

	if err := AssertTransition(previous, transitionRecord(services, nil, nil)); !errors.Is(err, ErrRevocationNeeded) {
		t.Fatalf("dropping an active pair = %v, want %v", err, ErrRevocationNeeded)
	}

	// Once revoked, dropping it is how a pair is retired.
	revoked := active
	revoked.PairState = "revoked"
	afterRevoke := transitionRecord(services, []Computer{revoked}, nil)
	if err := AssertTransition(afterRevoke, transitionRecord(services, nil, nil)); err != nil {
		t.Fatalf("dropping a revoked pair: %v", err)
	}

	// Forgetting the service also releases its pairs, once the forget is in the
	// previous state — the same ordering rule as removing a service.
	alreadyForgotten := transitionRecord(services, []Computer{active}, []string{firstService})
	if err := AssertTransition(alreadyForgotten, transitionRecord(nil, nil, []string{firstService})); err != nil {
		t.Fatalf("dropping a pair with its forgotten service: %v", err)
	}
}
