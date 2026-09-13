// Package catalog owns the on-disk device catalog: the registered
// coordinator services, the paired computers, and the identities the user
// has forgotten. The format, the file names and the refusal codes are the
// ones the shell already writes, so a record written by either side stays
// readable by both while ownership moves into the core.
package catalog

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// The refusal codes are part of the contract with the shell.
var (
	ErrInvalid          = errors.New("p2p.catalog_invalid")
	ErrIncomplete       = errors.New("p2p.catalog_incomplete")
	ErrExists           = errors.New("p2p.catalog_exists")
	ErrUnavailable      = errors.New("p2p.catalog_unavailable")
	ErrConflict         = errors.New("p2p.catalog_conflict")
	ErrWriteFailed      = errors.New("p2p.catalog_write_failed")
	ErrServiceNotFound  = errors.New("p2p.service_not_found")
	ErrIdentityMismatch = errors.New("p2p.identity_mismatch")
	ErrTrustRestore     = errors.New("p2p.trust_restore_rejected")
	ErrForgetRequired   = errors.New("p2p.forget_required")
	ErrRevocationNeeded = errors.New("p2p.revocation_required")
	ErrSettingsRoot     = errors.New("p2p.settings_root_required")
)

// MaxRecordBytes bounds a catalog file, matching the shell's reader.
const MaxRecordBytes = 64 * 1024

// Service is one registered coordinator.
type Service struct {
	ServiceID   string `json:"serviceId"`
	DisplayName string `json:"displayName"`
	HTTPSOrigin string `json:"httpsOrigin"`
	WSSURL      string `json:"wssUrl"`
	STUNAddress string `json:"stunAddress"`
	PublicKey   string `json:"publicKey"`
	Certificate string `json:"certificate"`
}

// Computer is one paired remote computer of one service.
type Computer struct {
	ConnectionID    string `json:"connectionId"`
	ServiceID       string `json:"serviceId"`
	DisplayName     string `json:"displayName"`
	PairID          string `json:"pairId"`
	NetworkID       string `json:"networkId"`
	LocalDeviceID   string `json:"localDeviceId"`
	RemoteDeviceID  string `json:"remoteDeviceId"`
	UserID          string `json:"userId"`
	LocalPublicKey  string `json:"localPublicKey"`
	RemotePublicKey string `json:"remotePublicKey"`
	PairRevision    int64  `json:"pairRevision"`
	PairState       string `json:"pairState"`
}

// Record is the whole catalog file.
type Record struct {
	Format              string     `json:"format"`
	Version             int        `json:"version"`
	CatalogID           string     `json:"catalogId"`
	Services            []Service  `json:"services"`
	Computers           []Computer `json:"computers"`
	ForgottenServiceIDs []string   `json:"forgottenServiceIds"`
}

// Snapshot pairs a record with the revision callers echo back on commit.
type Snapshot struct {
	Revision string `json:"revision"`
	Record   Record `json:"record"`
}

const recordFormat = "dshker.p2p-devices"

// Parse decodes and fully validates a catalog file the way the shell's
// parsePeerCatalog does: exact field sets, hex identifiers, ed25519 service
// certificates bound to the service id, endpoint shapes, and uniqueness.
func Parse(raw []byte) (Record, error) {
	if len(raw) == 0 || len(raw) > MaxRecordBytes {
		return Record{}, ErrInvalid
	}
	var record Record
	if err := strictJSON(raw, &record); err != nil {
		return Record{}, ErrInvalid
	}
	if record.Format != recordFormat || record.Version != 1 || !isID(record.CatalogID, 32) {
		return Record{}, ErrInvalid
	}
	if record.Services == nil || record.Computers == nil || record.ForgottenServiceIDs == nil {
		return Record{}, ErrInvalid
	}
	for _, service := range record.Services {
		if err := ValidateService(service); err != nil {
			return Record{}, err
		}
	}
	for _, computer := range record.Computers {
		if err := validateComputer(computer); err != nil {
			return Record{}, err
		}
	}
	for _, forgotten := range record.ForgottenServiceIDs {
		if !isID(forgotten, 64) {
			return Record{}, ErrInvalid
		}
	}
	serviceIDs := make([]string, 0, len(record.Services))
	known := make(map[string]bool, len(record.Services))
	for _, service := range record.Services {
		serviceIDs = append(serviceIDs, service.ServiceID)
		known[service.ServiceID] = true
	}
	connectionIDs := make([]string, 0, len(record.Computers))
	pairKeys := make([]string, 0, len(record.Computers))
	for _, computer := range record.Computers {
		connectionIDs = append(connectionIDs, computer.ConnectionID)
		pairKeys = append(pairKeys, computer.ServiceID+":"+computer.PairID)
		if !known[computer.ServiceID] {
			return Record{}, ErrInvalid
		}
	}
	for _, values := range [][]string{serviceIDs, connectionIDs, pairKeys, record.ForgottenServiceIDs} {
		if !unique(values) {
			return Record{}, ErrInvalid
		}
	}
	return record, nil
}

// ValidateService checks one service entry, including that the certificate is
// a self-signed ed25519 CA whose key is the service identity.
func ValidateService(service Service) error {
	if !isID(service.ServiceID, 64) || !isName(service.DisplayName) {
		return ErrInvalid
	}
	key, err := decodeKey(service.PublicKey)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(key)
	if hex.EncodeToString(digest[:]) != service.ServiceID {
		return ErrInvalid
	}
	if err := validateCertificate(service.Certificate, key); err != nil {
		return err
	}
	return ValidateEndpoints(service.HTTPSOrigin, service.WSSURL, service.STUNAddress)
}

// ValidateEndpoints pins the coordinator endpoint shapes: an https origin with
// no path or credentials, the wss signals URL on the same host, and a
// host:port STUN address.
func ValidateEndpoints(httpsOrigin, wssURL, stunAddress string) error {
	https, err := url.Parse(httpsOrigin)
	if err != nil || https.Scheme != "https" || https.Host == "" {
		return ErrInvalid
	}
	if httpsOrigin != "https://"+https.Host || https.User != nil || https.RawQuery != "" || https.Fragment != "" {
		return ErrInvalid
	}
	wss, err := url.Parse(wssURL)
	if err != nil || wss.Scheme != "wss" || wss.Host != https.Host || wss.Path != "/v1/signals" {
		return ErrInvalid
	}
	if wssURL != "wss://"+wss.Host+"/v1/signals" || wss.User != nil || wss.RawQuery != "" || wss.Fragment != "" {
		return ErrInvalid
	}
	host, port, found := strings.Cut(stunAddress, ":")
	if !found || host == "" || strings.ContainsAny(stunAddress, " \t\r\n") {
		return ErrInvalid
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return ErrInvalid
	}
	return nil
}

func validateCertificate(encoded string, publicKey []byte) error {
	bytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(bytes) == 0 || len(bytes) > 16*1024 {
		return ErrInvalid
	}
	if base64.StdEncoding.EncodeToString(bytes) != encoded {
		return ErrInvalid
	}
	certificate, err := x509.ParseCertificate(bytes)
	if err != nil || !certificate.IsCA {
		return ErrInvalid
	}
	key, ok := certificate.PublicKey.(ed25519.PublicKey)
	if !ok || !key.Equal(ed25519.PublicKey(publicKey)) {
		return ErrInvalid
	}
	if err := certificate.CheckSignatureFrom(certificate); err != nil {
		return ErrInvalid
	}
	return nil
}

func validateComputer(computer Computer) error {
	if !isID(computer.ConnectionID, 32) || !isID(computer.ServiceID, 64) || !isName(computer.DisplayName) {
		return ErrInvalid
	}
	for _, value := range []string{computer.PairID, computer.NetworkID, computer.LocalDeviceID, computer.RemoteDeviceID, computer.UserID} {
		if !isID(value, 32) {
			return ErrInvalid
		}
	}
	if computer.LocalDeviceID == computer.RemoteDeviceID {
		return ErrInvalid
	}
	if _, err := decodeKey(computer.LocalPublicKey); err != nil {
		return err
	}
	if _, err := decodeKey(computer.RemotePublicKey); err != nil {
		return err
	}
	if computer.LocalPublicKey == computer.RemotePublicKey || computer.PairRevision <= 0 {
		return ErrInvalid
	}
	if computer.PairState != "active" && computer.PairState != "revoked" {
		return ErrInvalid
	}
	return nil
}

func decodeKey(value string) ([]byte, error) {
	bytes, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(bytes) != 32 || base64.StdEncoding.EncodeToString(bytes) != value {
		return nil, ErrInvalid
	}
	return bytes, nil
}

func isID(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func isName(value string) bool {
	if value == "" || len(value) > 256 || strings.TrimSpace(value) != value {
		return false
	}
	for _, c := range value {
		if c == 0 || c == '\r' || c == '\n' || !unicode.IsPrint(c) && !unicode.IsSpace(c) {
			return false
		}
	}
	return true
}

func unique(values []string) bool {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

// strictJSON rejects unknown fields so a record the shell would refuse as an
// inexact object is refused here too.
func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.More() {
		return ErrInvalid
	}
	return nil
}
