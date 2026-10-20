package helper

import (
	"encoding/json"
	"errors"

	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func (account *account) entry(data json.RawMessage) (any, error) {
	var request struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}
	if protocol.DecodeExact(data, &request) != nil || !protocol.ValidID(request.PairID) || request.Generation == 0 {
		return nil, errors.New("p2p.invalid_request")
	}
	account.mu.Lock()
	if account.closed {
		account.mu.Unlock()
		return nil, errors.New("p2p.service_unconfigured")
	}
	manager := account.manager
	account.mu.Unlock()
	if manager == nil {
		return nil, errors.New("p2p.device_unregistered")
	}
	entry, err := manager.Entry(request.PairID, request.Generation)
	if err != nil {
		return nil, err
	}
	return struct {
		ServiceID string            `json:"serviceId"`
		State     peersession.State `json:"state"`
		URL       string            `json:"url"`
	}{account.identity.ServiceID, entry.State, entry.URL}, nil
}
