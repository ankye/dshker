package peersession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func candidateControlDiagnosticInputs() (*Manager, protocol.CandidateTicket, protocol.RegistrationFence) {
	manager := &Manager{accountUserID: "111111111111"}
	manager.config.Authority.ServiceID = "222222222222"
	manager.config.Device.DeviceID = "333333333333"
	manager.config.CoreInstanceID = strings.Repeat("4", 32)
	ticket := protocol.CandidateTicket{
		ServerEpoch: strings.Repeat("5", 32), FromCoreInstanceID: strings.Repeat("6", 32),
		ToCoreInstanceID: manager.config.CoreInstanceID, Signature: "signature-private-sentinel",
		Lease: protocol.Lease{
			AttemptID: strings.Repeat("7", 32), UserID: manager.accountUserID, NetworkID: "888888888888",
			PairID: manager.config.Device.DeviceID, FromDeviceID: "999999999999", ToDeviceID: manager.config.Device.DeviceID,
			Generation: 73, Signature: "lease-signature-private-sentinel",
		},
	}
	fence := protocol.RegistrationFence{ServerEpoch: ticket.ServerEpoch, SubscriptionID: strings.Repeat("a", 32), CoreInstanceID: manager.config.CoreInstanceID}
	manager.pins = map[string]controlplane.PairIdentity{"dddddddddddd": {
		Pair:      protocolPairForDiagnostic(ticket),
		Initiator: controlplane.PairDeviceIdentity{DeviceID: ticket.Lease.ToDeviceID},
		Target:    controlplane.PairDeviceIdentity{DeviceID: ticket.Lease.FromDeviceID},
	}}
	return manager, ticket, fence
}

func protocolPairForDiagnostic(ticket protocol.CandidateTicket) controlplane.Pair {
	return controlplane.Pair{PairID: "dddddddddddd", NetworkID: ticket.Lease.NetworkID, State: "active"}
}

func captureCandidateControlForTest(t *testing.T, manager *Manager, ticket protocol.CandidateTicket, fence protocol.RegistrationFence) candidateControlDiagnostic {
	t.Helper()
	manager.mu.Lock()
	record, ok := manager.captureCandidateControlDiagnosticLocked("prepared", "accepted", nil, ticket, fence, true)
	manager.mu.Unlock()
	if !ok {
		t.Fatal("valid bounded control identity was not captured")
	}
	return record
}

func TestCandidateControlDiagnosticSnapshotKeepsExactOwnerAndRedacts(t *testing.T) {
	manager, ticket, fence := candidateControlDiagnosticInputs()
	old := &session{lease: protocol.Lease{AttemptID: strings.Repeat("b", 32), Generation: 72}}
	manager.inboundCandidates = map[string]*session{"dddddddddddd": old}
	manager.inbound = map[string]*session{"dddddddddddd": {lease: protocol.Lease{AttemptID: strings.Repeat("c", 32), Generation: 71}}}
	manager.mu.Lock()
	record, ok := manager.captureCandidateControlDiagnosticLocked("prepared", "refused", fmt.Errorf("p2p.connection_busy: token=%s", "private-token-sentinel"), ticket, fence, true)
	manager.mu.Unlock()
	if !ok || record.At.IsZero() || record.At.Location() != time.UTC || record.Event != "prepared" || record.Disposition != "refused" || record.Code != "p2p.connection_busy" {
		t.Fatalf("control classification changed: %+v", record)
	}
	if record.ServiceID != manager.config.Authority.ServiceID || record.SubscriptionID != fence.SubscriptionID || record.ServerEpoch != fence.ServerEpoch || record.RegistrationCoreID != fence.CoreInstanceID || !record.RegistrationKnown || !record.CurrentSubscription || record.CoreInstanceID != manager.config.CoreInstanceID || record.AccountUserID != manager.accountUserID {
		t.Fatal("local account/subscription/core fence was not captured exactly")
	}
	if record.Direction != "answered" || !record.PairKnown || record.PairID != "dddddddddddd" || record.PairID == ticket.Lease.FromDeviceID || record.RemoteDeviceID != ticket.Lease.FromDeviceID || record.TicketPairID != ticket.Lease.PairID || record.TicketLocalCoreID != ticket.ToCoreInstanceID || record.TicketUserID != ticket.Lease.UserID || record.NetworkID != ticket.Lease.NetworkID || record.AttemptID != ticket.Lease.AttemptID || record.Generation != 73 {
		t.Fatal("incoming ticket scope was not captured exactly")
	}
	if record.ActualOwnerSlot != "candidate" || record.ActualOwnerAttemptID != old.lease.AttemptID || record.ActualOwnerGeneration != 72 {
		t.Fatal("busy reservation was confused with the primary or incoming owner")
	}
	before, ok := marshalCandidateControlDiagnostic(record)
	if !ok || !bytes.HasPrefix(before, []byte("candidate.control ")) || bytes.Count(before, []byte{'\n'}) != 1 || len(before) > 2048 {
		t.Fatal("control diagnostic was not one bounded prefixed line")
	}
	manager.mu.Lock()
	old.lease.AttemptID, old.lease.Generation = strings.Repeat("d", 32), 74
	manager.accountUserID = "eeeeeeeeeeee"
	manager.inboundCandidates = nil
	ticket.Lease.AttemptID, ticket.Signature = strings.Repeat("f", 32), "replacement-signature"
	manager.mu.Unlock()
	after, ok := marshalCandidateControlDiagnostic(record)
	if !ok || !bytes.Equal(before, after) {
		t.Fatal("later owner/account/ticket mutation changed the captured record")
	}
	for _, secret := range []string{"private-token-sentinel", "signature-private-sentinel", "lease-signature-private-sentinel", "replacement-signature", "token=", "https://", "SDP", "credential"} {
		if bytes.Contains(after, []byte(secret)) {
			t.Fatalf("control diagnostic leaked forbidden content %q", secret)
		}
	}
	var decoded candidateControlDiagnostic
	if err := json.Unmarshal(bytes.TrimSuffix(bytes.TrimPrefix(after, []byte("candidate.control ")), []byte{'\n'}), &decoded); err != nil || decoded != record {
		t.Fatal("serialized control snapshot did not read back exactly", err)
	}
}

func TestCandidateControlDiagnosticDirectionAndOwnerAreExplicit(t *testing.T) {
	for _, name := range []string{"answered-primary", "initiated-candidate", "reserved-prepare", "no-owner", "missing-pin", "unrelated"} {
		t.Run(name, func(t *testing.T) {
			manager, ticket, fence := candidateControlDiagnosticInputs()
			owner := &session{lease: protocol.Lease{AttemptID: strings.Repeat("b", 32), Generation: 72}}
			pair, direction, slot := "dddddddddddd", "answered", "absent"
			switch name {
			case "answered-primary":
				manager.inbound = map[string]*session{pair: owner}
				slot = "primary"
			case "initiated-candidate", "reserved-prepare":
				ticket.Lease.FromDeviceID, ticket.Lease.ToDeviceID = ticket.Lease.ToDeviceID, ticket.Lease.FromDeviceID
				ticket.FromCoreInstanceID, ticket.ToCoreInstanceID = ticket.ToCoreInstanceID, ticket.FromCoreInstanceID
				ticket.Lease.PairID = ticket.Lease.ToDeviceID
				direction, slot = "initiated", "candidate"
				manager.candidates = map[string]*session{pair: owner}
				if name == "reserved-prepare" {
					owner.prepare = &protocol.PrepareCandidate{AttemptID: strings.Repeat("c", 32), Generation: 75}
				}
			case "unrelated":
				ticket.Lease.ToDeviceID = "eeeeeeeeeeee"
				pair, direction = "", "unrelated"
			case "missing-pin":
				manager.pins = nil
				manager.inboundCandidates = map[string]*session{ticket.Lease.FromDeviceID: owner}
				pair = ""
			}
			record := captureCandidateControlForTest(t, manager, ticket, fence)
			if record.PairID != pair || record.Direction != direction || record.ActualOwnerSlot != slot {
				t.Fatalf("scope/slot projection changed: %+v", record)
			}
			if slot == "absent" && (record.ActualOwnerAttemptID != "" || record.ActualOwnerGeneration != 0) {
				t.Fatal("absent owner gained an invented identity")
			}
			if record.PairKnown != (pair != "") {
				t.Fatal("unconfirmed remote device was substituted for a real pair key")
			}
			if name == "reserved-prepare" && (record.ActualOwnerAttemptID != owner.prepare.AttemptID || record.ActualOwnerGeneration != 75) {
				t.Fatal("reserved prepare identity was replaced with a nonexistent lease")
			}
		})
	}
}

func TestCandidateControlDiagnosticRejectsInvalidFieldsWithoutWriting(t *testing.T) {
	manager, ticket, fence := candidateControlDiagnosticInputs()
	valid := captureCandidateControlForTest(t, manager, ticket, fence)
	for _, field := range []string{"event", "disposition", "service", "account", "ticket-user", "network", "pair", "ticket-pair", "core", "registration-core", "registration-known", "ticket-core", "epoch", "ticket-epoch", "subscription", "attempt", "generation-zero", "generation-overflow", "owner-attempt", "owner-generation", "queued-attempt", "queued-generation", "code", "time"} {
		t.Run(field, func(t *testing.T) {
			record := valid
			secret := "https://private.invalid/?token=private-sentinel\nSDP-secret"
			switch field {
			case "event":
				record.Event = secret
			case "disposition":
				record.Disposition = secret
			case "service":
				record.ServiceID = secret
			case "account":
				record.AccountUserID = secret
			case "ticket-user":
				record.TicketUserID = secret
			case "network":
				record.NetworkID = secret
			case "pair":
				record.PairID = secret
			case "ticket-pair":
				record.TicketPairID = secret
			case "core":
				record.CoreInstanceID = secret
			case "registration-core":
				record.RegistrationCoreID = secret
			case "registration-known":
				record.RegistrationKnown = false
			case "ticket-core":
				record.TicketLocalCoreID = secret
			case "epoch":
				record.ServerEpoch = secret
			case "ticket-epoch":
				record.TicketServerEpoch = secret
			case "subscription":
				record.SubscriptionID = strings.Repeat("a", 4096)
			case "attempt":
				record.AttemptID = secret
			case "generation-zero":
				record.Generation = 0
			case "generation-overflow":
				record.Generation = 1 << 53
			case "owner-attempt":
				record.ActualOwnerSlot, record.ActualOwnerAttemptID, record.ActualOwnerGeneration = "candidate", secret, 1
			case "owner-generation":
				record.ActualOwnerSlot, record.ActualOwnerAttemptID = "candidate", strings.Repeat("b", 32)
			case "queued-attempt":
				record.QueuedAdmissionAttemptID, record.QueuedAdmissionGeneration = secret, 1
			case "queued-generation":
				record.QueuedAdmissionAttemptID = strings.Repeat("b", 32)
			case "code":
				record.Code = "p2p.private_sentinel"
			case "time":
				record.At = time.Time{}
			}
			if encoded, ok := marshalCandidateControlDiagnostic(record); ok || encoded != nil || writeCandidateControlDiagnostic(record) {
				t.Fatal("invalid or unbounded metadata reached the stderr writer")
			}
		})
	}
	manager.mu.Lock()
	ticket.Lease.FromDeviceID = "private-device-sentinel"
	_, ok := manager.captureCandidateControlDiagnosticLocked("prepared", "refused", errors.New("p2p.candidate_scope_mismatch"), ticket, fence, true)
	manager.mu.Unlock()
	if ok {
		t.Fatal("invalid raw ticket identity was captured")
	}
}

func TestCandidateControlDiagnosticUnknownErrorDoesNotInventCause(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code string
	}{
		{"success", nil, "none"},
		{"cancel", fmt.Errorf("wrapped: %w", context.Canceled), "context.canceled"},
		{"deadline", context.DeadlineExceeded, "context.deadline_exceeded"},
		{"known", errors.New("p2p.registration_stale: private-token-sentinel"), "p2p.registration_stale"},
		{"identity-mismatch", errors.New("p2p.identity_mismatch: private-token-sentinel"), "p2p.identity_mismatch"},
		{"lease-scope-mismatch", errors.New("p2p.lease_scope_mismatch: private-token-sentinel"), "p2p.lease_scope_mismatch"},
		{"signal-scope-mismatch", errors.New("p2p.signal_scope_mismatch: private-token-sentinel"), "p2p.signal_scope_mismatch"},
		{"protocol-mismatch", errors.New("p2p.protocol_mismatch: private-token-sentinel"), "p2p.protocol_mismatch"},
		{"unknown", errors.New("https://private.invalid/?token=private-token-sentinel"), "unknown"},
		{"shaped-unknown", errors.New("p2p.private_token_sentinel"), "unknown"},
		{"signal-limit", errors.New("p2p.signal_limit: private-token-sentinel"), "p2p.signal_limit"},
		{"rate-limit", errors.New("p2p.rate_limited: private-token-sentinel"), "p2p.rate_limited"},
		{"network-revoked", errors.New("p2p.network_revoked: private-token-sentinel"), "p2p.network_revoked"},
		{"server-response", errors.New("p2p.invalid_server_response: private-token-sentinel"), "p2p.invalid_server_response"},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager, ticket, fence := candidateControlDiagnosticInputs()
			manager.mu.Lock()
			record, ok := manager.captureCandidateControlDiagnosticLocked("signal", "no_owner", test.err, ticket, fence, true)
			manager.mu.Unlock()
			encoded, encodedOK := marshalCandidateControlDiagnostic(record)
			if !ok || !encodedOK || record.Code != test.code || bytes.Contains(encoded, []byte("private")) {
				t.Fatal("raw error leaked or an unknown cause was mislabeled")
			}
		})
	}
}

func TestCandidateControlDiagnosticMissingAndStaleSubscriptionStayExplicit(t *testing.T) {
	manager, ticket, fence := candidateControlDiagnosticInputs()
	for _, current := range []bool{false, true} {
		manager.mu.Lock()
		record, ok := manager.captureCandidateControlDiagnosticLocked("prepared", "stale_fence", errors.New("p2p.signalling_not_ready"), ticket, protocol.RegistrationFence{}, current)
		manager.mu.Unlock()
		if !ok || record.CurrentSubscription != current || record.RegistrationKnown {
			t.Fatal("socket ownership was confused with unavailable registration evidence")
		}
		if record.SubscriptionID != "" || record.ServerEpoch != "" || record.RegistrationCoreID != "" {
			t.Fatal("missing registration metadata was fabricated")
		}
	}
	fence.ServerEpoch = strings.Repeat("b", 32)
	manager.mu.Lock()
	record, ok := manager.captureCandidateControlDiagnosticLocked("prepared", "stale_fence", errors.New("p2p.registration_stale"), ticket, fence, false)
	manager.mu.Unlock()
	if !ok || record.CurrentSubscription || record.ServerEpoch != fence.ServerEpoch || record.TicketServerEpoch != ticket.ServerEpoch || record.ServerEpoch == record.TicketServerEpoch {
		t.Fatal("stale/current epoch evidence was merged")
	}
	manager.mu.Lock()
	_, ok = manager.captureCandidateControlDiagnosticLocked("prepared", "stale_fence", nil, ticket, protocol.RegistrationFence{SubscriptionID: fence.SubscriptionID}, false)
	manager.mu.Unlock()
	if ok {
		t.Fatal("partial registration evidence was accepted")
	}
}

func TestCandidateControlDiagnosticQueuedAdmissionKeepsBlockingOwner(t *testing.T) {
	manager, ticket, fence := candidateControlDiagnosticInputs()
	pair := "dddddddddddd"
	old := &session{lease: protocol.Lease{AttemptID: strings.Repeat("b", 32), Generation: 72}}
	queued := &session{lease: ticket.Lease, ticket: &ticket}
	manager.inboundCandidates = map[string]*session{pair: old}
	manager.inboundAdmissions = map[string]*inboundAdmission{pair: {connection: queued}}
	record := captureCandidateControlForTest(t, manager, ticket, fence)
	if record.ActualOwnerSlot != "candidate" || record.ActualOwnerAttemptID != old.lease.AttemptID || record.ActualOwnerGeneration != 72 || record.QueuedAdmissionAttemptID != ticket.Lease.AttemptID || record.QueuedAdmissionGeneration != 73 {
		t.Fatal("queued successor concealed its old blocking owner or lost its own identity")
	}
	before, ok := marshalCandidateControlDiagnostic(record)
	if !ok {
		t.Fatal("valid queued admission was rejected")
	}
	manager.mu.Lock()
	delete(manager.inboundCandidates, pair)
	queued.lease.AttemptID, queued.lease.Generation = strings.Repeat("e", 32), 74
	manager.mu.Unlock()
	after, ok := marshalCandidateControlDiagnostic(record)
	if !ok || !bytes.Equal(before, after) {
		t.Fatal("asynchronous admission mutation changed an earlier control snapshot")
	}
	current := captureCandidateControlForTest(t, manager, ticket, fence)
	if current.ActualOwnerSlot != "admission" || current.ActualOwnerAttemptID != queued.lease.AttemptID || current.ActualOwnerGeneration != 74 || current.QueuedAdmissionAttemptID != queued.lease.AttemptID {
		t.Fatal("current queued admission was not projected after the old reservation left")
	}
}

func TestCandidateControlDiagnosticProgressKeepsOriginalDispatchFence(t *testing.T) {
	for _, event := range []string{"offer", "answer"} {
		t.Run(event, func(t *testing.T) {
			manager, ticket, fence := candidateControlDiagnosticInputs()
			started, ok := manager.captureCandidateControlDiagnostic(event, "started", nil, ticket, fence, true)
			if !ok {
				t.Fatal("offer/answer start was not captured")
			}
			manager.mu.Lock()
			manager.config.CoreInstanceID, manager.accountUserID = strings.Repeat("b", 32), "cccccccccccc"
			manager.mu.Unlock()
			for _, disposition := range []string{"gathered", "sent", "applied", "failed"} {
				completed, ok := candidateControlResult(started, disposition, errors.New("https://private.invalid/SDP?token=private-sentinel"))
				if !ok || completed.Event != event || completed.Disposition != disposition || completed.Code != "unknown" || completed.SubscriptionID != fence.SubscriptionID || completed.ServerEpoch != fence.ServerEpoch || completed.CoreInstanceID != ticket.ToCoreInstanceID || completed.AccountUserID != ticket.Lease.UserID || completed.At.Before(started.At) {
					t.Fatal("completion resampled a new subscription/scope or lost the original cause class")
				}
				encoded, ok := marshalCandidateControlDiagnostic(completed)
				if !ok || bytes.Contains(encoded, []byte("private")) || bytes.Contains(encoded, []byte("SDP")) {
					t.Fatal("offer/answer progress serialized signaling content or raw errors")
				}
			}
			if started.Disposition != "started" || started.Code != "none" {
				t.Fatal("completion mutated the earlier immutable phase snapshot")
			}
		})
	}
}
