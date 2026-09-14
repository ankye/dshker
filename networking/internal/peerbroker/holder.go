package peerbroker

import (
	"fmt"
	"sync"

	"github.com/ankye/dshker/networking/internal/remoteroute"
)

// Holder owns the one broker a core can run. A second start is refused rather
// than doubling: the endpoint is published to a remote peer by file, so two
// brokers would mean two descriptors and an ambiguous address.
type Holder struct {
	mutex  sync.Mutex
	broker *Broker
}

// Start publishes one endpoint whose runtime answer comes from the given route.
func (holder *Holder) Start(descriptorPath string, runtime RuntimeRoute, host string) (remoteroute.Descriptor, error) {
	holder.mutex.Lock()
	defer holder.mutex.Unlock()
	if holder.broker != nil {
		return remoteroute.Descriptor{}, fmt.Errorf("%w: the remote peer broker is already running.", remoteroute.ErrConnectionBusy)
	}
	broker := &Broker{DescriptorPath: descriptorPath, Runtime: runtime, Host: host}
	descriptor, err := broker.Start()
	if err != nil {
		return remoteroute.Descriptor{}, err
	}
	holder.broker = broker
	return descriptor, nil
}

// Stop retracts the published endpoint.
func (holder *Holder) Stop() error {
	holder.mutex.Lock()
	broker := holder.broker
	holder.broker = nil
	holder.mutex.Unlock()
	if broker == nil {
		return nil
	}
	return broker.Shutdown()
}

// Status reports the published descriptor, when one is live.
func (holder *Holder) Status() (remoteroute.Descriptor, bool) {
	holder.mutex.Lock()
	defer holder.mutex.Unlock()
	if holder.broker == nil {
		return remoteroute.Descriptor{}, false
	}
	return holder.broker.Descriptor()
}

// Shutdown retracts the endpoint when the core exits.
func (holder *Holder) Shutdown() { _ = holder.Stop() }
