package peer

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

// TransportReceiveDiagnostics contains only an explicitly available selected
// candidate-pair sample. Packet/byte fields exclude STUN (but include DTLS/SCTP),
// while request/response fields describe STUN connectivity checks. A nil field
// is unknown, not zero. The DataChannel timestamp is an actual callback receipt,
// independent of whether a selected-pair sample is available.
type TransportReceiveDiagnostics struct {
	Available                bool       `json:"available"`
	SampledAt                *time.Time `json:"sampledAt"`
	LastPacketReceivedAt     *time.Time `json:"lastPacketReceivedAt"`
	LastRequestReceivedAt    *time.Time `json:"lastRequestReceivedAt"`
	LastResponseReceivedAt   *time.Time `json:"lastResponseReceivedAt"`
	LastDataChannelMessageAt *time.Time `json:"lastDataChannelMessageAt"`
	PacketsReceived          *uint64    `json:"packetsReceived"`
	BytesReceived            *uint64    `json:"bytesReceived"`
	RequestsReceived         *uint64    `json:"requestsReceived"`
	ResponsesReceived        *uint64    `json:"responsesReceived"`
}

// TransportPathDiagnostics is only the selected pair's network tuple. It never
// includes candidate serialization, credentials, foundations or server URLs.
type TransportPathDiagnostics struct {
	LocalAddress  string `json:"localAddress"`
	LocalPort     int32  `json:"localPort"`
	LocalType     string `json:"localType"`
	RemoteAddress string `json:"remoteAddress"`
	RemotePort    int32  `json:"remotePort"`
	RemoteType    string `json:"remoteType"`
	Protocol      string `json:"protocol"`
}

// TransportFailure freezes the first local termination fact before cleanup.
// Code is a declared transport code, a standard context code, or "unknown";
// Trigger is a fixed owner/callback name. Neither can contain an error sentence.
type TransportFailure struct {
	Code              string                      `json:"code"`
	Trigger           string                      `json:"trigger"`
	At                time.Time                   `json:"at"`
	PCState           string                      `json:"pcState"`
	ICEState          string                      `json:"iceState"`
	DataChannelState  string                      `json:"dataChannelState"`
	Receive           TransportReceiveDiagnostics `json:"receive"`
	SelectedPath      *TransportPathDiagnostics   `json:"selectedPath"`
	LeaseExpiresAt    int64                       `json:"leaseExpiresAt"`
	LastLeaseUpdateAt *time.Time                  `json:"lastLeaseUpdateAt"`
}

// TransportDiagnostics is a credential-free local snapshot. Current states can
// change during cleanup; Failure, once present, never changes. The lease-update
// time means UpdateLease accepted a valid lease, not merely that HTTPS replied.
type TransportDiagnostics struct {
	At                time.Time                   `json:"at"`
	PCState           string                      `json:"pcState"`
	ICEState          string                      `json:"iceState"`
	DataChannelState  string                      `json:"dataChannelState"`
	Receive           TransportReceiveDiagnostics `json:"receive"`
	SelectedPath      *TransportPathDiagnostics   `json:"selectedPath"`
	LeaseExpiresAt    int64                       `json:"leaseExpiresAt"`
	LastLeaseUpdateAt *time.Time                  `json:"lastLeaseUpdateAt"`
	Failure           *TransportFailure           `json:"failure"`
}

type transportDiagnosticState struct {
	mu    sync.Mutex
	value TransportDiagnostics
}

// Diagnostics neither consumes Errors nor asks Pion for stats. All three Pion
// state getters below are atomic reads in the pinned dependency; full stats are
// collected only by the joined worker, never by a Pion callback.
func (transport *Transport) Diagnostics() TransportDiagnostics {
	pc, ice, channel := transport.diagnosticStates()
	transport.diagnostics.mu.Lock()
	defer transport.diagnostics.mu.Unlock()
	value := transport.diagnostics.value
	value.At = time.Now().UTC()
	value.PCState, value.ICEState, value.DataChannelState = pc, ice, channel
	value.Receive = cloneReceiveDiagnostics(value.Receive)
	value.SelectedPath = cloneDiagnosticPointer(value.SelectedPath)
	value.LastLeaseUpdateAt = cloneDiagnosticPointer(value.LastLeaseUpdateAt)
	if value.Failure != nil {
		first := *value.Failure
		first.Receive = cloneReceiveDiagnostics(first.Receive)
		first.SelectedPath = cloneDiagnosticPointer(first.SelectedPath)
		first.LastLeaseUpdateAt = cloneDiagnosticPointer(first.LastLeaseUpdateAt)
		value.Failure = &first
	}
	return value
}

func (transport *Transport) diagnosticStates() (pc, ice, channel string) {
	pc, ice, channel = "unknown", "unknown", "unknown"
	if transport.pc != nil {
		pc, ice = transport.pc.ConnectionState().String(), transport.pc.ICEConnectionState().String()
	}
	if transport.channel != nil {
		channel = transport.channel.ReadyState().String()
	}
	return pc, ice, channel
}

func (transport *Transport) recordTermination(trigger string, err error) {
	at := time.Now().UTC()
	pc, ice, channel := transport.diagnosticStates()
	transport.diagnostics.mu.Lock()
	defer transport.diagnostics.mu.Unlock()
	value := &transport.diagnostics.value
	if value.Failure != nil {
		return
	}
	value.Failure = &TransportFailure{
		Code: safeTransportFailureCode(err), Trigger: trigger, At: at,
		PCState: pc, ICEState: ice, DataChannelState: channel,
		Receive: cloneReceiveDiagnostics(value.Receive), LeaseExpiresAt: value.LeaseExpiresAt,
		SelectedPath:      cloneDiagnosticPointer(value.SelectedPath),
		LastLeaseUpdateAt: cloneDiagnosticPointer(value.LastLeaseUpdateAt),
	}
}

func safeTransportFailureCode(err error) string {
	if errors.Is(err, context.Canceled) {
		return "context.canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "context.deadline_exceeded"
	}
	code, _ := protocol.Refusal(err)
	// Refusal accepts vocabulary-shaped prefixes, not only declared constants.
	// Restrict diagnostic output further: library error text is never a code.
	switch code {
	case "p2p.direct_unavailable", "p2p.direct_closed", "p2p.unexpected_data_channel", "p2p.identity_mismatch",
		"p2p.protocol_limit", "p2p.receive_limit", "p2p.lease_expired":
		return code
	default:
		return "unknown"
	}
}

func (transport *Transport) recordLeaseUpdate(expiresAt int64) {
	transport.diagnostics.mu.Lock()
	defer transport.diagnostics.mu.Unlock()
	transport.diagnostics.value.LeaseExpiresAt = expiresAt
	transport.diagnostics.value.LastLeaseUpdateAt = diagnosticPointer(time.Now().UTC())
}

func (transport *Transport) recordMessageReceive() {
	transport.diagnostics.mu.Lock()
	defer transport.diagnostics.mu.Unlock()
	transport.diagnostics.value.Receive.LastDataChannelMessageAt = diagnosticPointer(time.Now().UTC())
}

func cloneReceiveDiagnostics(value TransportReceiveDiagnostics) TransportReceiveDiagnostics {
	value.SampledAt = cloneDiagnosticPointer(value.SampledAt)
	value.LastPacketReceivedAt = cloneDiagnosticPointer(value.LastPacketReceivedAt)
	value.LastRequestReceivedAt = cloneDiagnosticPointer(value.LastRequestReceivedAt)
	value.LastResponseReceivedAt = cloneDiagnosticPointer(value.LastResponseReceivedAt)
	value.LastDataChannelMessageAt = cloneDiagnosticPointer(value.LastDataChannelMessageAt)
	value.PacketsReceived = cloneDiagnosticPointer(value.PacketsReceived)
	value.BytesReceived = cloneDiagnosticPointer(value.BytesReceived)
	value.RequestsReceived = cloneDiagnosticPointer(value.RequestsReceived)
	value.ResponsesReceived = cloneDiagnosticPointer(value.ResponsesReceived)
	return value
}

func diagnosticPointer[T any](value T) *T { return &value }

func cloneDiagnosticPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return diagnosticPointer(*value)
}
