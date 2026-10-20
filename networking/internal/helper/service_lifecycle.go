package helper

// ForgetService ends the removed service's live authority after the core has
// committed its catalog removal. Its registered device and secrets are retained.
func (host *Host) ForgetService(serviceID string) {
	host.mu.Lock()
	host.removalRevision++
	if host.removedAt == nil {
		host.removedAt = make(map[string]uint64)
	}
	host.removedAt[serviceID] = host.removalRevision
	value := host.accounts[serviceID]
	delete(host.accounts, serviceID)
	host.mu.Unlock()
	host.cancelBootstraps(serviceID)
	if value != nil {
		value.close()
	}
}

func (value *account) close() {
	if value.cancel != nil {
		value.cancel()
	}
	value.mu.Lock()
	value.closed = true
	value.httpPhase = accountHTTPClosed
	manager, client, base := value.manager, value.client, value.base
	value.manager, value.client, value.base = nil, nil, nil
	value.mu.Unlock()
	if manager != nil {
		manager.Close()
	}
	if client != nil {
		client.Close()
	}
	if base != nil {
		base.Close()
	}
}
