// Package controlplane implements the public coordination protocol without server imports.
package controlplane

import "github.com/ankye/dshker/networking/internal/protocol"

// TurnCredentials is the device-scoped TURN relay credential set issued by the
// coordinator. The relay forwards only end-to-end encrypted packets; these
// credentials authorize the relay allocation, never plaintext access.
type TurnCredentials struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type Endpoints struct {
	HTTPSOrigin string `json:"httpsOrigin"`
	WSSURL      string `json:"wssUrl"`
	STUNAddress string `json:"stunAddress"`
}

type Identity struct {
	Version     int    `json:"version"`
	ServiceID   string `json:"serviceId"`
	PublicKey   []byte `json:"publicKey"`
	Certificate []byte `json:"certificate"`
	Nonce       string `json:"nonce"`
	HTTPSOrigin string `json:"httpsOrigin"`
	WSSURL      string `json:"wssUrl"`
	STUNAddress string `json:"stunAddress"`
	Signature   string `json:"signature"`
}

type User struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
}

type UserSession struct {
	User      User   `json:"user"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
}

type Network struct {
	NetworkID string `json:"networkId"`
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	// MaxDevices is the coordinator-owned device capacity. Without it the value
	// the server reports would be dropped on the way to the launcher.
	MaxDevices int `json:"maxDevices"`
}

type EnrollmentGrant struct {
	Token     string `json:"token"`
	NetworkID string `json:"networkId"`
	ExpiresAt int64  `json:"expiresAt"`
}

type Enrollment struct {
	RequestID string `json:"requestId"`
	Token     string `json:"token"`
	CSR       string `json:"csr"`
	Name      string `json:"name"`
}

// NetworkJoin enrols this device into a network without a user session.
//
// Possession of the networkId is the whole claim, so there is no token: the
// coordinator admits the device into that network's directory and makes the
// network's owner its owner. RequestID makes a retry idempotent.
type NetworkJoin struct {
	RequestID string `json:"requestId"`
	NetworkID string `json:"networkId"`
	CSR       string `json:"csr"`
	Name      string `json:"name"`
}

// DeviceEntry is a row of a network's device directory.
//
// It carries no certificate: the directory exists to identify and manage
// devices, and the coordinator deliberately withholds credential material here.
type DeviceEntry struct {
	DeviceID     string `json:"deviceId"`
	UserID       string `json:"userId"`
	Name         string `json:"name"`
	Presence     string `json:"presence"`
	LastSeen     int64  `json:"lastSeen"`
	Version      string `json:"version"`
	Platform     string `json:"platform"`
	Architecture string `json:"architecture"`
}

type Device struct {
	DeviceID    string `json:"deviceId"`
	UserID      string `json:"userId"`
	PublicKey   []byte `json:"publicKey"`
	Name        string `json:"name"`
	Certificate []byte `json:"certificate"`
}

type Share struct {
	Version     int    `json:"version"`
	ServiceID   string `json:"serviceId"`
	NetworkID   string `json:"networkId"`
	DeviceID    string `json:"deviceId"`
	Fingerprint string `json:"fingerprint"`
	Nonce       string `json:"nonce"`
	ExpiresAt   int64  `json:"expiresAt"`
	Signature   string `json:"signature"`
}

type Pair struct {
	PairID    string `json:"pairId"`
	NetworkID string `json:"networkId"`
	Initiator string `json:"initiator"`
	Target    string `json:"target"`
	State     string `json:"state"`
	ExpiresAt int64  `json:"expiresAt"`
	Revision  uint64 `json:"revision"`
}

type PairDeviceIdentity struct {
	DeviceID  string `json:"deviceId"`
	UserID    string `json:"userId"`
	PublicKey []byte `json:"publicKey"`
	Name      string `json:"name"`
	Presence  string `json:"presence"`
}

type PairIdentity struct {
	Pair      Pair               `json:"pair"`
	Initiator PairDeviceIdentity `json:"initiator"`
	Target    PairDeviceIdentity `json:"target"`
}

type Lease = protocol.Lease
