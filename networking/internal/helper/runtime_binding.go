package helper

import (
	"context"
	"errors"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

func (host *Host) runtimeBinding(ctx context.Context, method, serviceID, pairID string) (runtimebridge.Binding, error) {
	if method != "runtime.connect" && method != "runtime.resume" {
		return runtimebridge.Binding{}, errors.New("p2p.invalid_operation")
	}
	data, err := host.callMain(ctx, method, struct {
		ServiceID string `json:"serviceId"`
		PairID    string `json:"pairId"`
	}{serviceID, pairID})
	var binding runtimebridge.Binding
	if err == nil {
		err = protocol.DecodeExact(data, &binding)
	}
	return binding, err
}
