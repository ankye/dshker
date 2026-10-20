package peersession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
)

func TestSessionDiagnosticPreservesFirstOwnerCauseAndRedactsDetails(t *testing.T) {
	connection := newSession(context.Background())
	defer connection.cancel()
	connection.PairID = "pair-sentinel"
	connection.lease.AttemptID, connection.lease.Generation = "attempt-sentinel", 17
	manager := &Manager{}
	manager.config.Authority.ServiceID = "service-sentinel"
	manager.config.Device.DeviceID = "local-sentinel"
	connection.lease.FromDeviceID = manager.config.Device.DeviceID
	secret := "private-payload-cookie-and-token-sentinel"
	connection.stop("pair_revoked", fmt.Errorf("p2p.pair_revoked: Bearer %s", secret))
	connection.noteStop("session_context_done", context.Canceled)
	connection.noteStop("mux_done", fmt.Errorf("untrusted %s", secret))
	record := manager.sessionDiagnostic(connection, "terminated", peer.TransportDiagnostics{})
	if record.FirstTermination == nil || record.FirstTermination.Trigger != "pair_revoked" || record.FirstTermination.Code != "p2p.pair_revoked" {
		t.Fatalf("first owner cause lost: %+v", record.FirstTermination)
	}
	if record.ServiceID != "service-sentinel" || record.PairID != "pair-sentinel" || record.AttemptID != "attempt-sentinel" || record.Generation != 17 || record.Direction != "initiated" {
		t.Fatalf("diagnostic identity changed: %+v", record)
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), secret) || strings.Contains(string(data), "Bearer") {
		t.Fatal("diagnostic leaked raw owner error details")
	}
	var decoded sessionDiagnosticRecord
	if err := json.Unmarshal(data, &decoded); err != nil || decoded.FirstTermination.Trigger != "pair_revoked" {
		t.Fatalf("serialized first cause readback failed: %v", err)
	}
	// A caller inspecting one record cannot change the stored first cause.
	record.FirstTermination.Trigger = "mutated"
	if next := manager.sessionDiagnostic(connection, "terminated", peer.TransportDiagnostics{}); next.FirstTermination.Trigger != "pair_revoked" {
		t.Fatal("diagnostic readback mutated stored first cause")
	}
}

func TestSessionDiagnosticPreservesEarlierTransportCauseAcrossCleanup(t *testing.T) {
	connection := newSession(context.Background())
	defer connection.cancel()
	firstAt := time.Now().Add(-time.Second).UTC()
	connection.noteStop("transport_done", nil)
	transport := peer.TransportDiagnostics{Failure: &peer.TransportFailure{
		At: firstAt, Trigger: "ice_grace_expired", Code: "p2p.direct_unavailable", ICEState: "disconnected",
	}}
	record := (&Manager{}).sessionDiagnostic(connection, "terminated", transport)
	if record.FirstTermination == nil || record.FirstTermination.At != firstAt || record.FirstTermination.Trigger != "transport.ice_grace_expired" || record.FirstTermination.Code != "p2p.direct_unavailable" {
		t.Fatalf("transport first cause lost: %+v", record.FirstTermination)
	}
	if record.SessionBoundary == nil || record.SessionBoundary.Trigger != "transport_done" || record.Transport.Failure.ICEState != "disconnected" {
		t.Fatal("actual session boundary or first-failure transport state lost")
	}
}

func TestSessionDiagnosticOwnerStopPrecedesTransportTeardown(t *testing.T) {
	connection := newSession(context.Background())
	defer connection.cancel()
	connection.stop("explicit_disconnect", nil)
	transport := peer.TransportDiagnostics{Failure: &peer.TransportFailure{
		At: time.Now().Add(time.Second).UTC(), Trigger: "owner_context", Code: "context.canceled",
	}}
	record := (&Manager{}).sessionDiagnostic(connection, "terminated", transport)
	if record.FirstTermination == nil || record.FirstTermination.Trigger != "explicit_disconnect" || record.FirstTermination.Code != "none" {
		t.Fatalf("cleanup overwrote explicit first owner: %+v", record.FirstTermination)
	}
}

func TestSessionDiagnosticRenewalKeepsLastSuccessOnFailure(t *testing.T) {
	connection := newSession(context.Background())
	defer connection.cancel()
	connection.recordRenewal(nil)
	manager := &Manager{}
	first := manager.sessionDiagnostic(connection, "health", peer.TransportDiagnostics{})
	if first.Lease.LastSuccessAt == nil || first.Lease.LastAttemptAt == nil || first.Lease.LastCode != "none" {
		t.Fatalf("successful renewal not readable: %+v", first.Lease)
	}
	secret := "https://credential-sentinel.invalid/?token=secret-sentinel"
	connection.recordRenewal(errors.New(secret))
	second := manager.sessionDiagnostic(connection, "lease_renewal_failed", peer.TransportDiagnostics{})
	if second.Lease.LastCode != "unknown" || second.Lease.LastSuccessAt == nil || !second.Lease.LastSuccessAt.Equal(*first.Lease.LastSuccessAt) || second.Lease.LastAttemptAt.Before(*first.Lease.LastAttemptAt) {
		t.Fatalf("renewal failure invented success or discarded last success: %+v", second.Lease)
	}
	data, err := json.Marshal(second)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "credential-sentinel") || strings.Contains(string(data), "secret-sentinel") {
		t.Fatal("renewal diagnostic exposed raw request/credential text")
	}
}

func TestSessionDiagnosticConcurrentStopsDoNotReplaceFirst(t *testing.T) {
	connection := newSession(context.Background())
	defer connection.cancel()
	connection.noteStop("runtime_invalidated", errors.New("p2p.runtime_invalidated"))
	var workers sync.WaitGroup
	for range 32 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			connection.stop("late_cleanup", context.Canceled)
			connection.recordRenewal(context.Canceled)
			_ = (&Manager{}).sessionDiagnostic(connection, "health", peer.TransportDiagnostics{})
		}()
	}
	workers.Wait()
	record := (&Manager{}).sessionDiagnostic(connection, "terminated", peer.TransportDiagnostics{})
	if record.FirstTermination.Trigger != "runtime_invalidated" || record.FirstTermination.Code != "p2p.runtime_invalidated" {
		t.Fatal("late concurrent stop replaced first owner cause")
	}
}

func TestSessionDiagnosticObserverEndsWithOwnerContext(t *testing.T) {
	connection := newSession(context.Background())
	connection.transport = &peer.Transport{}
	done := make(chan struct{})
	go func() { defer close(done); (&Manager{}).observeSession(connection) }()
	connection.stop("explicit_disconnect", nil)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("read-only diagnostic observer outlived the session")
	}
}

func TestSessionDiagnosticObservationPreservesSampledPathChanges(t *testing.T) {
	first := peer.TransportDiagnostics{SelectedPath: &peer.TransportPathDiagnostics{
		LocalAddress: "fe80::1%feth1266", LocalPort: 40000, LocalType: "host",
		RemoteAddress: "fe80::2%feth1266", RemotePort: 50000, RemoteType: "host", Protocol: "udp",
	}}
	second := first
	copyPath := *first.SelectedPath
	second.SelectedPath = &copyPath
	if event := sessionObservationEvent(first, second, false); event != "" {
		t.Fatal("identical sampled paths generated duplicate transition logs")
	}
	second.SelectedPath.RemotePort++
	if event := sessionObservationEvent(first, second, false); event != "path_observed" {
		t.Fatal("selected path replacement was not recorded")
	}
	unknown := first
	unknown.SelectedPath = nil
	if event := sessionObservationEvent(first, unknown, false); event != "path_observed" {
		t.Fatal("loss of an observed selected path was hidden")
	}
	if event := sessionObservationEvent(unknown, first, false); event != "path_observed" {
		t.Fatal("newly observed selected path was hidden")
	}
	second.ICEState = "disconnected"
	if event := sessionObservationEvent(first, second, true); event != "state_observed" {
		t.Fatal("transport state transition lost its sampled path record")
	}
	if event := sessionObservationEvent(first, first, true); event != "health" {
		t.Fatal("unchanged sampled path suppressed the bounded health record")
	}
}
