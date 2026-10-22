package main

import (
	"context"
	"errors"
	"os"

	"github.com/ankye/dshker/networking/internal/core"
)

// The launcher supplies a native secret namespace only for explicitly isolated
// profiles. Such a profile must never inspect or register the stable OS job.
func isolatedProfile() bool { return os.Getenv("DSHKER_SECRET_NAMESPACE") != "" }

func autostartForProfile(authority core.Autostart) core.Autostart {
	if isolatedProfile() {
		return isolatedAutostart{}
	}
	return authority
}

func retireAutostartForProfile(state string) error {
	if isolatedProfile() {
		return nil
	}
	return retireDisabledAutostart(state)
}

type isolatedAutostart struct{}

func (isolatedAutostart) Install(context.Context) error {
	return errors.New("p2p.autostart_unsupported")
}

func (isolatedAutostart) Remove(context.Context) error {
	return errors.New("p2p.autostart_unsupported")
}

func (isolatedAutostart) Status(context.Context) (core.AutostartView, error) {
	return core.AutostartView{}, errors.New("p2p.autostart_unsupported")
}
