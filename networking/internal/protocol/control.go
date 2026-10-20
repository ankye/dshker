package protocol

import "time"

const ControlVersion = 2
const ControlSubprotocol = "dshker.signal.v2"
const CapabilityCandidate = "connection.candidate.v1"
const CandidateVersion = 1
const CandidateLifetime = 120 * time.Second

type RegistrationFence struct {
	ServerEpoch    string `json:"serverEpoch"`
	SubscriptionID string `json:"subscriptionId"`
	CoreInstanceID string `json:"coreInstanceId"`
}

type ControlHello struct {
	Version        int      `json:"version"`
	Type           string   `json:"type"`
	UserID         string   `json:"userId"`
	CoreInstanceID string   `json:"coreInstanceId"`
	Capabilities   []string `json:"capabilities"`
}

type ControlReady struct {
	Version      int               `json:"version"`
	Type         string            `json:"type"`
	DeviceID     string            `json:"deviceId"`
	UserID       string            `json:"userId"`
	Registration RegistrationFence `json:"registration"`
	Capabilities []string          `json:"capabilities"`
}

type PeerRegistration struct {
	Version        int      `json:"version"`
	Type           string   `json:"type"`
	ServerEpoch    string   `json:"serverEpoch"`
	DeviceID       string   `json:"deviceId"`
	UserID         string   `json:"userId"`
	CoreInstanceID string   `json:"coreInstanceId"`
	Capabilities   []string `json:"capabilities"`
	Online         bool     `json:"online"`
}

type LinkStateRequest struct {
	Registration RegistrationFence `json:"registration"`
	UserID       string            `json:"userId"`
	NetworkID    string            `json:"networkId"`
	PairID       string            `json:"pairId"`
}

// PairID is a pairs-table record id for this discovery read only.
type PairIdentityRequest struct {
	Registration RegistrationFence `json:"registration"`
	UserID       string            `json:"userId"`
	NetworkID    string            `json:"networkId"`
	PairID       string            `json:"pairId"`
}

type LinkState struct {
	ServerEpoch             string   `json:"serverEpoch"`
	CurrentActiveAttemptID  string   `json:"currentActiveAttemptId"`
	CurrentActiveGeneration uint64   `json:"currentActiveGeneration"`
	PeerCoreInstanceID      string   `json:"peerCoreInstanceId"`
	PeerCapabilities        []string `json:"peerCapabilities"`
}

type PrepareCandidate struct {
	Registration       RegistrationFence `json:"registration"`
	AttemptID          string            `json:"attemptId"`
	UserID             string            `json:"userId"`
	NetworkID          string            `json:"networkId"`
	PairID             string            `json:"pairId"`
	Generation         uint64            `json:"generation"`
	PreviousAttemptID  string            `json:"previousAttemptId"`
	PreviousGeneration uint64            `json:"previousGeneration"`
	ToCoreInstanceID   string            `json:"toCoreInstanceId"`
}

type CandidateTicket struct {
	Version            int    `json:"version"`
	Lease              Lease  `json:"lease"`
	ServerEpoch        string `json:"serverEpoch"`
	PreviousAttemptID  string `json:"previousAttemptId"`
	PreviousGeneration uint64 `json:"previousGeneration"`
	FromCoreInstanceID string `json:"fromCoreInstanceId"`
	ToCoreInstanceID   string `json:"toCoreInstanceId"`
	PrepareDeadline    int64  `json:"prepareDeadline"`
	Signature          string `json:"signature"`
}

type CandidateAction struct {
	Registration RegistrationFence `json:"registration"`
	Ticket       CandidateTicket   `json:"ticket"`
}

type CandidateStateRequest struct {
	Registration RegistrationFence `json:"registration"`
	AttemptID    string            `json:"attemptId"`
	UserID       string            `json:"userId"`
	NetworkID    string            `json:"networkId"`
	PairID       string            `json:"pairId"`
}

// Decision is immutable once terminal. Lease records the exact signed authority
// at that decision; later renewals are returned separately as LatestLease.
type CandidateDecision struct {
	Status    string `json:"status"`
	Reason    string `json:"reason"`
	DecidedAt int64  `json:"decidedAt"`
	Lease     Lease  `json:"lease"`
}

type CandidateState struct {
	Ticket                  CandidateTicket   `json:"ticket"`
	Decision                CandidateDecision `json:"decision"`
	LatestLease             Lease             `json:"latestLease"`
	FromReady               bool              `json:"fromReady"`
	ToReady                 bool              `json:"toReady"`
	CurrentActiveAttemptID  string            `json:"currentActiveAttemptId"`
	CurrentActiveGeneration uint64            `json:"currentActiveGeneration"`
}

type EndCandidate struct {
	Registration RegistrationFence `json:"registration"`
	Ticket       CandidateTicket   `json:"ticket"`
	Reason       string            `json:"reason"`
}

type EndResult struct {
	AttemptID               string `json:"attemptId"`
	Generation              uint64 `json:"generation"`
	Ended                   bool   `json:"ended"`
	Reason                  string `json:"reason"`
	CurrentActiveAttemptID  string `json:"currentActiveAttemptId"`
	CurrentActiveGeneration uint64 `json:"currentActiveGeneration"`
}

type CandidatePreparedEvent struct {
	Version int             `json:"version"`
	Type    string          `json:"type"`
	Ticket  CandidateTicket `json:"ticket"`
}

type CandidateDecisionEvent struct {
	Version int            `json:"version"`
	Type    string         `json:"type"`
	State   CandidateState `json:"state"`
}

type CandidateSignal struct {
	Version int             `json:"version"`
	Type    string          `json:"type"`
	Ticket  CandidateTicket `json:"ticket"`
	Signal  Signal          `json:"signal"`
}

type ControlRevoked struct {
	Version  int    `json:"version"`
	Type     string `json:"type"`
	PairID   string `json:"pairId"`
	Revision uint64 `json:"revision"`
}
