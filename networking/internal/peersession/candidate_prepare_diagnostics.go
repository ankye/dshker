package peersession

import (
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// prepareDiagnostic contains only bounded identity and error classification.
// It cannot retain a ticket, key, certificate, endpoint or raw error.
type prepareDiagnostic struct {
	At                 time.Time `json:"at"`
	Phase              string    `json:"phase"`
	Code               string    `json:"code"`
	ServiceID          string    `json:"serviceId"`
	AccountUserID      string    `json:"accountUserId"`
	LocalDeviceID      string    `json:"localDeviceId"`
	LocalCoreID        string    `json:"localCoreInstanceId"`
	PairID             string    `json:"pairId"`
	UserID             string    `json:"userId"`
	NetworkID          string    `json:"networkId"`
	RemoteDeviceID     string    `json:"remoteDeviceId"`
	AttemptID          string    `json:"attemptId"`
	Generation         uint64    `json:"generation"`
	PreviousAttemptID  string    `json:"previousAttemptId"`
	PreviousGeneration uint64    `json:"previousGeneration"`
	RemoteCoreKnown    bool      `json:"remoteCoreKnown"`
	RemoteCoreID       string    `json:"remoteCoreInstanceId"`
	RegistrationKnown  bool      `json:"registrationKnown"`
	ServerEpoch        string    `json:"serverEpoch"`
	SubscriptionID     string    `json:"subscriptionId"`
	RegistrationCoreID string    `json:"registrationCoreInstanceId"`
}

// Each phase owns its throttle, so the prepare/state retry cycle cannot bypass
// suppression by alternating phases. The array bounds the reporter's memory.
type prepareDiagnosticReporter struct {
	identity prepareDiagnostic
	mu       sync.Mutex
	last     [5]prepareDiagnostic
}

// Call outside manager.mu. Only scalars are captured under the ownership lock;
// the reporter retains neither the manager nor the mutable session/request.
func (manager *Manager) newPrepareDiagnostic(connection *session) *prepareDiagnosticReporter {
	reporter := &prepareDiagnosticReporter{}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if connection == nil || connection.prepare == nil || connection.ticket != nil {
		return reporter
	}
	request := *connection.prepare
	reporter.identity = prepareDiagnostic{
		ServiceID: manager.config.Authority.ServiceID, AccountUserID: manager.accountUserID,
		LocalDeviceID: manager.config.Device.DeviceID, LocalCoreID: manager.config.CoreInstanceID,
		PairID: connection.PairID, UserID: request.UserID, NetworkID: request.NetworkID,
		RemoteDeviceID: request.PairID, AttemptID: request.AttemptID, Generation: request.Generation,
	}
	return reporter
}

// report uses the exact request/fence for the operation being diagnosed. A
// missing fence or peer core stays explicitly unknown until actually obtained.
// Diagnostic refusal/write failure cannot change candidate admission or retry.
func (reporter *prepareDiagnosticReporter) report(phase string, request protocol.PrepareCandidate, cause error) {
	record, ok := reporter.captureAt(time.Now().UTC(), phase, request, cause)
	if !ok {
		return
	}
	encoded, ok := marshalPrepareDiagnostic(record)
	if ok {
		_, _ = os.Stderr.Write(encoded)
	}
}

func (reporter *prepareDiagnosticReporter) captureAt(now time.Time, phase string, request protocol.PrepareCandidate, cause error) (prepareDiagnostic, bool) {
	index := prepareDiagnosticPhaseIndex(phase)
	if reporter == nil || index < 0 {
		return prepareDiagnostic{}, false
	}
	record := reporter.identity
	if record.AttemptID != request.AttemptID || record.Generation != request.Generation || record.UserID != request.UserID || record.NetworkID != request.NetworkID || record.RemoteDeviceID != request.PairID {
		return prepareDiagnostic{}, false
	}
	record.At, record.Phase, record.Code = now, phase, prepareDiagnosticCode(cause)
	record.PreviousAttemptID, record.PreviousGeneration = request.PreviousAttemptID, request.PreviousGeneration
	record.RemoteCoreID, record.RemoteCoreKnown = request.ToCoreInstanceID, request.ToCoreInstanceID != ""
	fence := request.Registration
	record.ServerEpoch, record.SubscriptionID, record.RegistrationCoreID = fence.ServerEpoch, fence.SubscriptionID, fence.CoreInstanceID
	record.RegistrationKnown = fence.ServerEpoch != "" || fence.SubscriptionID != "" || fence.CoreInstanceID != ""
	if !validPrepareDiagnostic(record) {
		return prepareDiagnostic{}, false
	}
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	previous := reporter.last[index]
	comparison := record
	comparison.At = previous.At
	if !previous.At.IsZero() && comparison == previous && now.Sub(previous.At) < time.Minute {
		return prepareDiagnostic{}, false
	}
	reporter.last[index] = record
	return record, true
}

func prepareDiagnosticPhaseIndex(phase string) int {
	switch phase {
	case "registration":
		return 0
	case "link-state":
		return 1
	case "prepare":
		return 2
	case "state":
		return 3
	case "resolved":
		return 4
	default:
		return -1
	}
}

func prepareDiagnosticCode(cause error) string {
	code := candidateControlDiagnosticCode(cause)
	if code != "unknown" {
		return code
	}
	code, _ = protocol.Refusal(cause)
	switch code {
	case "p2p.server_unavailable", "p2p.missing_field", "p2p.invalid_fields", "p2p.peer_offline":
		return code
	default:
		return "unknown"
	}
}

func validPrepareDiagnostic(record prepareDiagnostic) bool {
	if record.At.IsZero() || record.At.Location() != time.UTC || prepareDiagnosticPhaseIndex(record.Phase) < 0 {
		return false
	}
	for _, id := range []string{record.ServiceID, record.AccountUserID, record.LocalDeviceID, record.PairID, record.UserID, record.NetworkID, record.RemoteDeviceID} {
		if !protocol.ValidID(id) {
			return false
		}
	}
	if !protocol.ValidNonce(record.LocalCoreID) || !protocol.ValidNonce(record.AttemptID) || !protocol.ValidGeneration(record.Generation) {
		return false
	}
	if record.PreviousAttemptID == "" && record.PreviousGeneration != 0 || record.PreviousAttemptID != "" && (!protocol.ValidAttemptID(record.PreviousAttemptID) || !protocol.ValidGeneration(record.PreviousGeneration)) {
		return false
	}
	if record.RemoteCoreKnown && !protocol.ValidNonce(record.RemoteCoreID) || !record.RemoteCoreKnown && record.RemoteCoreID != "" {
		return false
	}
	if record.RegistrationKnown {
		if !protocol.ValidNonce(record.ServerEpoch) || !protocol.ValidNonce(record.SubscriptionID) || !protocol.ValidNonce(record.RegistrationCoreID) {
			return false
		}
	} else if record.ServerEpoch != "" || record.SubscriptionID != "" || record.RegistrationCoreID != "" {
		return false
	}
	return record.Code == "none" || record.Code == "unknown" || record.Code == "context.canceled" || record.Code == "context.deadline_exceeded" || prepareDiagnosticCode(errors.New(record.Code)) == record.Code
}

func marshalPrepareDiagnostic(record prepareDiagnostic) ([]byte, bool) {
	if !validPrepareDiagnostic(record) {
		return nil, false
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return nil, false
	}
	line := append(append([]byte("candidate.prepare "), encoded...), '\n')
	if len(line) > 2048 {
		return nil, false
	}
	return line, true
}
