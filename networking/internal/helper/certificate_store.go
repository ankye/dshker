package helper

import (
	"bytes"
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/secret"
)

// This sidecar leaves the canonical version-1 credential schema unchanged.
// An empty network means an older installation never recorded a recovery scope.
type certificateMetadata struct {
	Version          int    `json:"version"`
	NetworkID        string `json:"networkId"`
	PendingRequestID string `json:"pendingRequestId"`
}

func certificateMetadataKey(serviceID string) string { return "account.certificate." + serviceID }

func (host *Host) certificateStore() secret.Store {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.deviceKeys
}

func (host *Host) loadCertificateMetadata(serviceID string) (certificateMetadata, error) {
	store := host.certificateStore()
	if store == nil {
		return certificateMetadata{}, errors.New("p2p.certificate_persist_failed")
	}
	data, err := store.Get(certificateMetadataKey(serviceID))
	if errors.Is(err, secret.ErrMissing) {
		return certificateMetadata{Version: 1}, nil
	}
	if err != nil {
		return certificateMetadata{}, errors.New("p2p.certificate_sync_failed")
	}
	var metadata certificateMetadata
	if protocol.DecodeExact(data, &metadata) != nil || metadata.Version != 1 ||
		(metadata.NetworkID != "" && !protocol.ValidID(metadata.NetworkID)) ||
		(metadata.PendingRequestID != "" && !protocol.ValidID(metadata.PendingRequestID)) {
		return certificateMetadata{}, errors.New("p2p.certificate_sync_failed")
	}
	return metadata, nil
}

func (host *Host) saveCertificateMetadata(serviceID string, metadata certificateMetadata) error {
	store := host.certificateStore()
	if store == nil {
		return errors.New("p2p.certificate_persist_failed")
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return errors.New("p2p.certificate_persist_failed")
	}
	previous, readErr := store.Get(certificateMetadataKey(serviceID))
	if readErr != nil && !errors.Is(readErr, secret.ErrMissing) {
		return errors.New("p2p.certificate_persist_failed")
	}
	if !bytes.Equal(previous, data) {
		if err := store.Set(certificateMetadataKey(serviceID), data); err != nil {
			return errors.New("p2p.certificate_persist_failed")
		}
	}
	readback, err := store.Get(certificateMetadataKey(serviceID))
	if err != nil || !bytes.Equal(data, readback) {
		return errors.New("p2p.certificate_persist_failed")
	}
	return nil
}
