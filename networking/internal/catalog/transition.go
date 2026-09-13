package catalog

import "encoding/json"

// AssertTransition enforces identity continuity between two catalog states,
// so persistence refuses an incorrect workflow even when the caller is the
// core itself: a forgotten identity is never silently restored, a service key
// never changes under the same id, a service is only dropped after being
// forgotten, and a computer is only dropped after being revoked.
func AssertTransition(previous, next Record) error {
	forgotten := make(map[string]bool, len(previous.ForgottenServiceIDs))
	for _, id := range previous.ForgottenServiceIDs {
		forgotten[id] = true
	}
	nextForgotten := make(map[string]bool, len(next.ForgottenServiceIDs))
	for _, id := range next.ForgottenServiceIDs {
		nextForgotten[id] = true
	}
	for _, id := range previous.ForgottenServiceIDs {
		if !nextForgotten[id] {
			return ErrTrustRestore
		}
	}
	services := make(map[string]Service, len(previous.Services))
	for _, service := range previous.Services {
		services[service.ServiceID] = service
	}
	for _, service := range next.Services {
		old, had := services[service.ServiceID]
		if forgotten[service.ServiceID] && (!had || !sameJSON(old, service)) {
			return ErrTrustRestore
		}
		if had && old.PublicKey != service.PublicKey {
			return ErrIdentityMismatch
		}
	}
	nextServices := make(map[string]bool, len(next.Services))
	for _, service := range next.Services {
		nextServices[service.ServiceID] = true
	}
	for _, service := range previous.Services {
		if !nextServices[service.ServiceID] && !forgotten[service.ServiceID] {
			return ErrForgetRequired
		}
	}
	computers := make(map[string]Computer, len(previous.Computers))
	for _, computer := range previous.Computers {
		computers[computer.ConnectionID] = computer
	}
	for _, computer := range next.Computers {
		old, had := computers[computer.ConnectionID]
		if forgotten[computer.ServiceID] && (!had || !sameJSON(old, computer)) {
			return ErrTrustRestore
		}
		if had {
			if err := assertComputerTransition(old, computer); err != nil {
				return err
			}
		}
	}
	nextComputers := make(map[string]bool, len(next.Computers))
	for _, computer := range next.Computers {
		nextComputers[computer.ConnectionID] = true
	}
	for _, computer := range previous.Computers {
		if !nextComputers[computer.ConnectionID] && computer.PairState != "revoked" && !forgotten[computer.ServiceID] {
			return ErrRevocationNeeded
		}
	}
	return nil
}

func assertComputerTransition(previous, next Computer) error {
	if previous.ServiceID != next.ServiceID ||
		previous.PairID != next.PairID ||
		previous.NetworkID != next.NetworkID ||
		previous.LocalDeviceID != next.LocalDeviceID ||
		previous.RemoteDeviceID != next.RemoteDeviceID ||
		previous.UserID != next.UserID ||
		previous.LocalPublicKey != next.LocalPublicKey ||
		previous.RemotePublicKey != next.RemotePublicKey {
		return ErrIdentityMismatch
	}
	if next.PairRevision < previous.PairRevision {
		return ErrTrustRestore
	}
	if previous.PairState == "revoked" && next.PairState != "revoked" {
		return ErrTrustRestore
	}
	return nil
}

func sameJSON(left, right any) bool {
	one, err := json.Marshal(left)
	if err != nil {
		return false
	}
	two, err := json.Marshal(right)
	if err != nil {
		return false
	}
	return string(one) == string(two)
}
