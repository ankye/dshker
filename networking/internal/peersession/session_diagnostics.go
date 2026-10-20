package peersession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type sessionTermination struct {
	At      time.Time `json:"at"`
	Trigger string    `json:"trigger"`
	Code    string    `json:"code"`
}

type sessionLeaseDiagnostic struct {
	LastAttemptAt *time.Time `json:"lastAttemptAt"`
	LastSuccessAt *time.Time `json:"lastSuccessAt"`
	LastCode      string     `json:"lastCode"`
}

type sessionDiagnosticState struct {
	mu          sync.Mutex
	termination *sessionTermination
	lease       sessionLeaseDiagnostic
}

// Only named codes cross this diagnostic boundary, never error details or URLs.
func sessionDiagnosticCode(err error) string {
	if err == nil {
		return "none"
	}
	if errors.Is(err, context.Canceled) {
		return "context.canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "context.deadline_exceeded"
	}
	if code, ok := protocol.Refusal(err); ok {
		return code
	}
	return "unknown"
}

func (connection *session) noteStop(trigger string, err error) {
	connection.diagnostic.mu.Lock()
	defer connection.diagnostic.mu.Unlock()
	if connection.diagnostic.termination == nil {
		connection.diagnostic.termination = &sessionTermination{
			At: time.Now().UTC(), Trigger: trigger, Code: sessionDiagnosticCode(err),
		}
	}
}

func (connection *session) stop(trigger string, err error) {
	connection.noteStop(trigger, err)
	connection.cancel()
}

func (connection *session) recordRenewal(err error) {
	now := time.Now().UTC()
	connection.diagnostic.mu.Lock()
	defer connection.diagnostic.mu.Unlock()
	connection.diagnostic.lease.LastAttemptAt = &now
	connection.diagnostic.lease.LastCode = sessionDiagnosticCode(err)
	if err == nil {
		connection.diagnostic.lease.LastSuccessAt = &now
	}
}

type sessionDiagnosticRecord struct {
	At               time.Time                 `json:"at"`
	Event            string                    `json:"event"`
	ServiceID        string                    `json:"serviceId"`
	PairID           string                    `json:"pairId"`
	AttemptID        string                    `json:"attemptId"`
	Generation       uint64                    `json:"generation"`
	Direction        string                    `json:"direction"`
	SessionBoundary  *sessionTermination       `json:"sessionBoundary"`
	FirstTermination *sessionTermination       `json:"firstTermination"`
	Lease            sessionLeaseDiagnostic    `json:"leaseRenewal"`
	Transport        peer.TransportDiagnostics `json:"transport"`
}

func (manager *Manager) sessionDiagnostic(connection *session, event string, transport peer.TransportDiagnostics) sessionDiagnosticRecord {
	record := sessionDiagnosticRecord{
		At: time.Now().UTC(), Event: event, ServiceID: manager.config.Authority.ServiceID,
		PairID: connection.PairID, AttemptID: connection.lease.AttemptID,
		Generation: connection.lease.Generation, Direction: "answered", Transport: transport,
	}
	if connection.lease.FromDeviceID == manager.config.Device.DeviceID {
		record.Direction = "initiated"
	}
	connection.diagnostic.mu.Lock()
	if first := connection.diagnostic.termination; first != nil {
		value := *first
		record.SessionBoundary, record.FirstTermination = &value, &value
	}
	record.Lease = connection.diagnostic.lease
	connection.diagnostic.mu.Unlock()
	if record.Lease.LastAttemptAt == nil {
		record.Lease.LastCode = "not_attempted"
	}
	if first := transport.Failure; first != nil && (record.FirstTermination == nil || !first.At.After(record.FirstTermination.At)) {
		record.FirstTermination = &sessionTermination{At: first.At, Trigger: "transport." + first.Trigger, Code: first.Code}
	}
	return record
}

func (manager *Manager) logSessionDiagnostic(connection *session, event string, transport peer.TransportDiagnostics) {
	writeSessionDiagnostic(manager.sessionDiagnostic(connection, event, transport))
}

func writeSessionDiagnostic(record sessionDiagnosticRecord) {
	encoded, err := json.Marshal(record)
	if err != nil {
		// All fields are closed, typed metadata. An encoder error remains explicit
		// without retrying or serializing the failed value and its possible detail.
		fmt.Fprintln(os.Stderr, "session.diagnostic_encode_failed")
		return
	}
	fmt.Fprintf(os.Stderr, "session.diagnostic %s\n", encoded)
}

// Read-only local samples never probe the peer or create browser traffic.
// State changes are observed at one second; healthy summaries are bounded to
// once a minute. The owner joins this worker on every session exit.
func (manager *Manager) observeSession(connection *session) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	previous := connection.transport.Diagnostics()
	manager.logSessionDiagnostic(connection, "observing", previous)
	nextHealth := time.Now().Add(time.Minute)
	for {
		select {
		case <-connection.ctx.Done():
			return
		case now := <-ticker.C:
			current := connection.transport.Diagnostics()
			if event := sessionObservationEvent(previous, current, !now.Before(nextHealth)); event != "" {
				manager.logSessionDiagnostic(connection, event, current)
			}
			if !now.Before(nextHealth) {
				nextHealth = now.Add(time.Minute)
			}
			previous = current
		}
	}
}

func sessionObservationEvent(previous, current peer.TransportDiagnostics, healthDue bool) string {
	if current.PCState != previous.PCState || current.ICEState != previous.ICEState || current.DataChannelState != previous.DataChannelState {
		return "state_observed"
	}
	// This is the last completed local sample, not a synchronous path probe.
	// Its receive.sampledAt remains in the same record, including unknown paths.
	if (previous.SelectedPath == nil) != (current.SelectedPath == nil) ||
		(previous.SelectedPath != nil && current.SelectedPath != nil && *previous.SelectedPath != *current.SelectedPath) {
		return "path_observed"
	}
	if healthDue {
		return "health"
	}
	return ""
}
