package peersession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func prepareDiagnosticInputs() (*Manager, *session, protocol.PrepareCandidate) {
	manager := &Manager{accountUserID: "111111111111"}
	manager.config.Authority.ServiceID = "222222222222"
	manager.config.Authority.PublicKey = []byte("private-public-key-sentinel")
	manager.config.Authority.Certificate = []byte("private-certificate-sentinel")
	manager.config.Authority.HTTPSOrigin = "https://private.invalid/?token=private-url-sentinel"
	manager.config.PrivateKey = []byte("private-signing-key-sentinel")
	manager.config.Device.DeviceID = "333333333333"
	manager.config.CoreInstanceID = strings.Repeat("4", 32)
	request := protocol.PrepareCandidate{
		Registration: protocol.RegistrationFence{
			ServerEpoch: strings.Repeat("5", 32), SubscriptionID: strings.Repeat("6", 32), CoreInstanceID: strings.Repeat("7", 32),
		},
		AttemptID: strings.Repeat("8", 32), UserID: "999999999999", NetworkID: "aaaaaaaaaaaa", PairID: "bbbbbbbbbbbb", Generation: 41,
		PreviousAttemptID: "cccccccccccc", PreviousGeneration: 40, ToCoreInstanceID: strings.Repeat("d", 32),
	}
	connection := &session{PairID: "eeeeeeeeeeee", prepare: &request}
	return manager, connection, request
}

func TestPrepareDiagnosticExactRequestSnapshotAndRedaction(t *testing.T) {
	manager, connection, request := prepareDiagnosticInputs()
	reporter := manager.newPrepareDiagnostic(connection)
	now := time.Date(2026, 10, 21, 1, 2, 3, 0, time.UTC)
	record, ok := reporter.captureAt(now, "prepare", request, errors.New("p2p.rate_limited: token=private-token-sentinel\nSDP=private-body-sentinel"))
	if !ok {
		t.Fatal("actual valid pre-ticket request was suppressed")
	}
	encoded, ok := marshalPrepareDiagnostic(record)
	if !ok || !bytes.HasPrefix(encoded, []byte("candidate.prepare ")) || bytes.Count(encoded, []byte{'\n'}) != 1 || len(encoded) > 2048 {
		t.Fatalf("diagnostic is not one bounded prefixed line: %d bytes", len(encoded))
	}
	var actual map[string]any
	if err := json.Unmarshal(bytes.TrimSuffix(bytes.TrimPrefix(encoded, []byte("candidate.prepare ")), []byte{'\n'}), &actual); err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{
		"at": now.Format(time.RFC3339Nano), "phase": "prepare", "code": "p2p.rate_limited",
		"serviceId": manager.config.Authority.ServiceID, "accountUserId": manager.accountUserID,
		"localDeviceId": manager.config.Device.DeviceID, "localCoreInstanceId": manager.config.CoreInstanceID,
		"pairId": connection.PairID, "userId": request.UserID, "networkId": request.NetworkID, "remoteDeviceId": request.PairID,
		"attemptId": request.AttemptID, "generation": float64(request.Generation),
		"previousAttemptId": request.PreviousAttemptID, "previousGeneration": float64(request.PreviousGeneration),
		"remoteCoreKnown": true, "remoteCoreInstanceId": request.ToCoreInstanceID,
		"registrationKnown": true, "serverEpoch": request.Registration.ServerEpoch,
		"subscriptionId": request.Registration.SubscriptionID, "registrationCoreInstanceId": request.Registration.CoreInstanceID,
	}
	if len(actual) != len(expected) {
		t.Fatalf("closed diagnostic schema changed: got %d fields, want %d", len(actual), len(expected))
	}
	for key, want := range expected {
		if actual[key] != want {
			t.Errorf("%s = %v, want actual source value %v", key, actual[key], want)
		}
	}
	for _, forbidden := range []string{"private-", "token=", "SDP=", "https://", "signature", "certificate", "publicKey", "ticket", "deadline", "lease"} {
		if bytes.Contains(encoded, []byte(forbidden)) {
			t.Errorf("diagnostic leaked forbidden content %q", forbidden)
		}
	}
	manager.accountUserID = "ffffffffffff"
	manager.config.Device.DeviceID = "0123456789ab"
	manager.config.CoreInstanceID = strings.Repeat("e", 32)
	connection.PairID, connection.prepare = "0123456789ab", nil
	again, ok := marshalPrepareDiagnostic(record)
	if !ok || !bytes.Equal(encoded, again) {
		t.Fatal("a later owner/account mutation changed the captured prepare scope")
	}
}

func TestPrepareDiagnosticUnknownFieldsAreExplicit(t *testing.T) {
	manager, connection, request := prepareDiagnosticInputs()
	request.Registration, request.ToCoreInstanceID = protocol.RegistrationFence{}, ""
	request.PreviousAttemptID, request.PreviousGeneration = "", 0
	connection.prepare = &request
	record, ok := manager.newPrepareDiagnostic(connection).captureAt(time.Now().UTC(), "registration", request, errors.New("p2p.signalling_not_ready"))
	if !ok || record.RegistrationKnown || record.ServerEpoch != "" || record.SubscriptionID != "" || record.RegistrationCoreID != "" || record.RemoteCoreKnown || record.RemoteCoreID != "" || record.PreviousAttemptID != "" || record.PreviousGeneration != 0 {
		t.Fatalf("pre-link-state uncertainty gained an invented fence, remote core or predecessor: %+v", record)
	}
}

func TestPrepareDiagnosticThrottlesEachPhaseAndReportsChanges(t *testing.T) {
	manager, connection, request := prepareDiagnosticInputs()
	reporter := manager.newPrepareDiagnostic(connection)
	start := time.Date(2026, 10, 21, 1, 2, 3, 0, time.UTC)
	for tick := 0; tick < 240; tick++ {
		now := start.Add(time.Duration(tick) * 250 * time.Millisecond)
		for _, phase := range []string{"prepare", "state"} {
			_, ok := reporter.captureAt(now, phase, request, errors.New("p2p.server_unavailable: private-token-sentinel"))
			if ok != (tick == 0) {
				t.Fatalf("repeated alternating phases bypassed 60s throttle at tick %d phase %s: emitted=%v", tick, phase, ok)
			}
		}
	}
	if _, ok := reporter.captureAt(start.Add(time.Minute), "prepare", request, errors.New("p2p.server_unavailable")); !ok {
		t.Fatal("unchanged prepare heartbeat was not emitted at 60s")
	}
	changedAt := start.Add(time.Minute + time.Millisecond)
	if _, ok := reporter.captureAt(changedAt, "prepare", request, errors.New("p2p.rate_limited")); !ok {
		t.Fatal("a changed typed code was suppressed")
	}
	request.Registration.SubscriptionID = strings.Repeat("f", 32)
	if record, ok := reporter.captureAt(changedAt, "prepare", request, errors.New("p2p.rate_limited")); !ok || record.SubscriptionID != request.Registration.SubscriptionID {
		t.Fatal("a real registration scope change was hidden by throttling")
	}
	if _, ok := reporter.captureAt(start, "prepare", request, errors.New("p2p.rate_limited")); ok {
		t.Fatal("wall-clock rollback bypassed unchanged-record throttle")
	}
}

func TestPrepareDiagnosticRejectsCrossOwnerRequests(t *testing.T) {
	for _, field := range []string{"attempt", "generation", "user", "network", "remote"} {
		t.Run(field, func(t *testing.T) {
			manager, connection, request := prepareDiagnosticInputs()
			reporter := manager.newPrepareDiagnostic(connection)
			switch field {
			case "attempt":
				request.AttemptID = strings.Repeat("f", 32)
			case "generation":
				request.Generation++
			case "user":
				request.UserID = "ffffffffffff"
			case "network":
				request.NetworkID = "ffffffffffff"
			case "remote":
				request.PairID = "ffffffffffff"
			}
			if _, ok := reporter.captureAt(time.Now().UTC(), "prepare", request, nil); ok {
				t.Fatal("reporter relabeled a different attempt as its original operation")
			}
		})
	}
}

func TestPrepareDiagnosticRejectsInvalidIdentityAndUnboundedFields(t *testing.T) {
	manager, connection, request := prepareDiagnosticInputs()
	valid, ok := manager.newPrepareDiagnostic(connection).captureAt(time.Now().UTC(), "prepare", request, nil)
	if !ok {
		t.Fatal("valid record was not captured")
	}
	for _, field := range []string{"time", "timezone", "phase", "code", "service", "account", "local-device", "local-core", "pair", "user", "network", "remote-device", "attempt", "generation-zero", "generation-overflow", "predecessor-attempt", "predecessor-generation", "remote-core", "remote-known", "registration-known", "epoch", "subscription", "registration-core"} {
		t.Run(field, func(t *testing.T) {
			record := valid
			secret := strings.Repeat("private-token-sentinel\n", 4096)
			switch field {
			case "time":
				record.At = time.Time{}
			case "timezone":
				record.At = record.At.In(time.FixedZone("other", 3600))
			case "phase":
				record.Phase = secret
			case "code":
				record.Code = secret
			case "service":
				record.ServiceID = secret
			case "account":
				record.AccountUserID = ""
			case "local-device":
				record.LocalDeviceID = secret
			case "local-core":
				record.LocalCoreID = secret
			case "pair":
				record.PairID = secret
			case "user":
				record.UserID = secret
			case "network":
				record.NetworkID = secret
			case "remote-device":
				record.RemoteDeviceID = secret
			case "attempt":
				record.AttemptID = secret
			case "generation-zero":
				record.Generation = 0
			case "generation-overflow":
				record.Generation = 1 << 53
			case "predecessor-attempt":
				record.PreviousAttemptID = ""
			case "predecessor-generation":
				record.PreviousGeneration = 0
			case "remote-core":
				record.RemoteCoreID = secret
			case "remote-known":
				record.RemoteCoreKnown = false
			case "registration-known":
				record.RegistrationKnown = false
			case "epoch":
				record.ServerEpoch = ""
			case "subscription":
				record.SubscriptionID = secret
			case "registration-core":
				record.RegistrationCoreID = secret
			}
			if encoded, ok := marshalPrepareDiagnostic(record); ok || len(encoded) != 0 {
				t.Fatal("invalid diagnostic was serialized")
			}
		})
	}
	if _, ok := manager.newPrepareDiagnostic(nil).captureAt(time.Now().UTC(), "prepare", request, nil); ok {
		t.Fatal("nil operation acquired an invented identity")
	}
}

func TestPrepareDiagnosticCodeClassifiesWithoutGuessing(t *testing.T) {
	for _, input := range []struct {
		err  error
		want string
	}{
		{nil, "none"},
		{fmt.Errorf("wrapped: %w", context.Canceled), "context.canceled"},
		{context.DeadlineExceeded, "context.deadline_exceeded"},
		{errors.New("p2p.server_unavailable: private-token-sentinel"), "p2p.server_unavailable"},
		{errors.New("p2p.missing_field: private-field-sentinel"), "p2p.missing_field"},
		{errors.New("p2p.invalid_fields: private-body-sentinel"), "p2p.invalid_fields"},
		{errors.New("p2p.peer_offline"), "p2p.peer_offline"},
		{errors.New("p2p.attempt_not_found"), "p2p.attempt_not_found"},
		{errors.New("p2p.rate_limited\nprivate-token-sentinel"), "unknown"},
		{errors.New("untrusted server text says p2p.rate_limited"), "unknown"},
		{errors.New("p2p.new_unrecognized_private_detail"), "unknown"},
	} {
		if got := prepareDiagnosticCode(input.err); got != input.want {
			t.Errorf("classification = %q, want %q", got, input.want)
		}
	}
}

func TestPrepareDiagnosticWriterReadbackAndSuppression(t *testing.T) {
	manager, connection, request := prepareDiagnosticInputs()
	reporter := manager.newPrepareDiagnostic(connection)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	previousStderr := os.Stderr
	os.Stderr = writer
	defer func() { os.Stderr = previousStderr }()
	reporter.report("prepare", request, context.Canceled)
	reporter.report("prepare", request, context.Canceled)
	reporter.report("state", request, context.DeadlineExceeded)
	reporter.report("unrecognized-private-sentinel", request, errors.New("private-error-sentinel"))
	invalid := request
	invalid.Registration.SubscriptionID = "private-subscription-sentinel"
	reporter.report("resolved", invalid, nil)
	manager.newPrepareDiagnostic(nil).report("prepare", request, nil)
	os.Stderr = previousStderr
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	written, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSuffix(written, []byte{'\n'}), []byte{'\n'})
	if len(lines) != 2 || bytes.Contains(written, []byte("private-")) {
		t.Fatalf("writer did not suppress duplicate/invalid output: lines=%d", len(lines))
	}
	for index, line := range lines {
		var record prepareDiagnostic
		if !bytes.HasPrefix(line, []byte("candidate.prepare ")) || len(line)+1 > 2048 {
			t.Fatal("stderr contains an unbounded or unprefixed line")
		}
		if err := json.Unmarshal(bytes.TrimPrefix(line, []byte("candidate.prepare ")), &record); err != nil {
			t.Fatal(err)
		}
		wantPhase, wantCode := "prepare", "context.canceled"
		if index == 1 {
			wantPhase, wantCode = "state", "context.deadline_exceeded"
		}
		if record.Phase != wantPhase || record.Code != wantCode || record.AttemptID != request.AttemptID || record.Generation != request.Generation || record.SubscriptionID != request.Registration.SubscriptionID || record.RemoteDeviceID != request.PairID {
			t.Fatalf("stderr readback diverged from actual request: %+v", record)
		}
	}
}

func TestPrepareDiagnosticMaximumValidValuesAndTicketIsolation(t *testing.T) {
	manager, connection, request := prepareDiagnosticInputs()
	request.Generation, request.PreviousGeneration = 1<<53-1, 1<<53-1
	request.PreviousAttemptID = strings.Repeat("f", 32)
	connection.prepare = &request
	record, ok := manager.newPrepareDiagnostic(connection).captureAt(time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC), "registration", request, errors.New("p2p.candidate_scope_mismatch"))
	if !ok {
		t.Fatal("maximum legal protocol identity was rejected")
	}
	encoded, ok := marshalPrepareDiagnostic(record)
	var decoded prepareDiagnostic
	if !ok || len(encoded) > 2048 || json.Unmarshal(bytes.TrimSuffix(bytes.TrimPrefix(encoded, []byte("candidate.prepare ")), []byte{'\n'}), &decoded) != nil || decoded != record {
		t.Fatalf("maximum legal diagnostic failed bounded exact readback: bytes=%d", len(encoded))
	}
	t.Logf("maximum legal diagnostic line: %d bytes (limit 2048)", len(encoded))
	connection.ticket = &protocol.CandidateTicket{Signature: "private-ticket-sentinel"}
	if _, ok := manager.newPrepareDiagnostic(connection).captureAt(time.Now().UTC(), "prepare", request, nil); ok {
		t.Fatal("an installed ticket was treated as a newly reserved pre-ticket operation")
	}
}
