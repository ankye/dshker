package peer

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTransportDiagnosticsRetainsFirstCauseWithoutConsumingErrors(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()
	transport.recordLeaseUpdate(time.Now().Add(time.Minute).Unix())
	transport.recordMessageReceive()
	transport.publishDiagnosticSample(transportDiagnosticSample{SelectedPath: &TransportPathDiagnostics{LocalAddress: "127.0.0.1", LocalPort: 10001, RemoteAddress: "127.0.0.1", RemotePort: 10002, Protocol: "udp"}})
	firstError := errors.New("p2p.lease_expired: token=do-not-log-this-value")
	transport.failFrom("lease-expired", firstError)
	first := transport.Diagnostics().Failure
	if first == nil || first.Code != "p2p.lease_expired" || first.Trigger != "lease-expired" || first.At.IsZero() {
		t.Fatal("first actual termination cause, trigger and time were not retained")
	}
	var workers sync.WaitGroup
	for range 20 {
		workers.Go(func() {
			transport.publishDiagnosticSample(transportDiagnosticSample{})
			transport.recordLeaseUpdate(time.Now().Add(2 * time.Minute).Unix())
			transport.recordMessageReceive()
			transport.failFrom("data-channel-close", errors.New("p2p.direct_closed"))
			_ = transport.Diagnostics()
		})
	}
	workers.Wait()
	if !reflect.DeepEqual(first, transport.Diagnostics().Failure) {
		t.Fatal("secondary shutdown or health updates overwrote the frozen first failure")
	}
	select {
	case got := <-transport.Errors():
		if got != firstError {
			t.Fatal("diagnostic reads changed the first transport error channel value")
		}
	default:
		t.Fatal("diagnostic reads consumed the transport error channel")
	}
}

func TestTransportDiagnosticsCopiesReturnedPointers(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()
	transport.recordLeaseUpdate(time.Now().Add(time.Minute).Unix())
	transport.recordMessageReceive()
	transport.diagnostics.value.Receive.PacketsReceived = diagnosticPointer(uint64(7))
	transport.diagnostics.value.SelectedPath = &TransportPathDiagnostics{LocalAddress: "127.0.0.1", LocalPort: 10001, RemoteAddress: "127.0.0.1", RemotePort: 10002, Protocol: "udp"}
	transport.failFrom("lease-expired", errors.New("p2p.lease_expired"))
	want := transport.Diagnostics()
	returned := transport.Diagnostics()
	*returned.LastLeaseUpdateAt = time.Time{}
	*returned.Receive.LastDataChannelMessageAt = time.Time{}
	*returned.Receive.PacketsReceived = 0
	returned.SelectedPath.LocalPort = 0
	returned.Failure.Code = "modified"
	*returned.Failure.LastLeaseUpdateAt = time.Time{}
	*returned.Failure.Receive.LastDataChannelMessageAt = time.Time{}
	*returned.Failure.Receive.PacketsReceived = 0
	returned.Failure.SelectedPath.RemotePort = 0
	actual := transport.Diagnostics()
	actual.At = want.At
	if !reflect.DeepEqual(want, actual) {
		t.Fatal("a caller mutated transport diagnostics through returned pointer aliases")
	}
}

func TestTransportDiagnosticsRedactsUntrustedErrorVocabulary(t *testing.T) {
	for _, message := range []string{
		"channel failed token=fixture-token cookie=fixture-cookie ufrag=fixture-ufrag",
		"p2p.fixture_token_cookie_ufrag",
	} {
		transport := newGraceTestTransport()
		transport.failFrom("data-channel-error", errors.New(message))
		encoded, err := json.Marshal(transport.Diagnostics())
		transport.cancel()
		if err != nil {
			t.Fatal(err)
		}
		if transport.Diagnostics().Failure.Code != "unknown" {
			t.Fatal("an undeclared library error masqueraded as a known diagnostic code")
		}
		for _, secret := range []string{"fixture-token", "fixture-cookie", "fixture-ufrag", "fixture_token_cookie_ufrag"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatal("credential-bearing error content escaped into diagnostic JSON")
			}
		}
	}
}

func TestTransportDiagnosticsOwnerCancellationPrecedesCloseConsequences(t *testing.T) {
	transport := newGraceTestTransport()
	transport.cancel()
	transport.failFrom("peer-connection-closed", errors.New("p2p.direct_unavailable"))
	first := transport.Diagnostics().Failure
	if first == nil || first.Trigger != "owner-context" || first.Code != "context.canceled" {
		t.Fatal("a peer close consequence replaced the already-canceled owner cause")
	}
}

func TestTransportDiagnosticsOnlyAcceptedLeaseUpdatesAdvanceTime(t *testing.T) {
	options, _ := optionsPair(t)
	transport, err := NewTransport(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	initial := transport.Diagnostics()
	if initial.LeaseExpiresAt != options.Lease.ExpiresAt || initial.LastLeaseUpdateAt != nil {
		t.Fatal("initial lease grant was misrepresented as an accepted renewal")
	}
	unknown := transport.sampleTransportDiagnostics()
	if unknown.Receive.Available || unknown.Receive.PacketsReceived != nil || unknown.Receive.RequestsReceived != nil || unknown.Receive.LastPacketReceivedAt != nil || unknown.SelectedPath != nil {
		t.Fatal("a transport without a selected pair invented receive activity")
	}
	if err := transport.UpdateLease(options.Lease); err != nil {
		t.Fatal(err)
	}
	accepted := transport.Diagnostics()
	if accepted.LastLeaseUpdateAt == nil || accepted.LastLeaseUpdateAt.IsZero() {
		t.Fatal("successful UpdateLease did not record its acceptance time")
	}
	invalid := options.Lease
	invalid.Signature = "invalid"
	if err := transport.UpdateLease(invalid); err == nil {
		t.Fatal("an invalid lease was accepted")
	}
	current := transport.Diagnostics()
	if !current.LastLeaseUpdateAt.Equal(*accepted.LastLeaseUpdateAt) || current.LeaseExpiresAt != accepted.LeaseExpiresAt {
		t.Fatal("a refused lease changed the last successful lease acceptance fact")
	}
}

func TestTransportDiagnosticsCloseJoinsSampler(t *testing.T) {
	options, _ := optionsPair(t)
	transport, err := NewTransport(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-transport.diagnosticsDone:
	default:
		t.Fatal("Close returned while its diagnostic sampler was still running")
	}
	first := transport.Diagnostics().Failure
	if first == nil || first.Trigger != "close" || first.Code != "p2p.direct_closed" {
		t.Fatal("explicit Close did not retain its own cause before Pion teardown")
	}
}
