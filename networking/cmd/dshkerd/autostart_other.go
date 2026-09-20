//go:build !darwin && !windows

package main

// Linux and every other platform: no registration mechanism is implemented yet.
//
// systemd --user is the obvious candidate, but a correct implementation has to
// deal with machines that have no systemd, with `loginctl enable-linger` for a
// service that must survive logout, and with distributions that place user units
// differently. Reporting a typed refusal is the honest answer until that is built:
// the rule this satisfies is that an unavailable mechanism must never be reported
// as a successful installation.

import "errors"

func installAutostart(_ string, _ string) error {
	return errors.New("p2p.autostart_unsupported")
}

func removeAutostart() error {
	return errors.New("p2p.autostart_unsupported")
}

func autostartStatus() (AutostartState, error) {
	return AutostartState{Installed: false, Mechanism: "unsupported"}, nil
}
