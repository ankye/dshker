package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/ankye/dshker/networking/internal/core"
)

type observedAutostart struct{ calls int }

func (authority *observedAutostart) Install(context.Context) error { authority.calls++; return nil }
func (authority *observedAutostart) Remove(context.Context) error  { authority.calls++; return nil }
func (authority *observedAutostart) Status(context.Context) (core.AutostartView, error) {
	authority.calls++
	return core.AutostartView{}, nil
}

func TestIsolatedProfileCannotAccessSystemAutostart(t *testing.T) {
	t.Setenv("DSHKER_SECRET_NAMESPACE", "profile-unit-test")
	stable := &observedAutostart{}
	authority := autostartForProfile(stable)
	ctx := context.Background()
	for name, invoke := range map[string]func() error{
		"enable":  func() error { return authority.Install(ctx) },
		"disable": func() error { return authority.Remove(ctx) },
		"status":  func() error { _, err := authority.Status(ctx); return err },
	} {
		if err := invoke(); err == nil || err.Error() != "p2p.autostart_unsupported" {
			t.Fatalf("%s = %v, want typed unsupported", name, err)
		}
	}
	if stable.calls != 0 {
		t.Fatal("isolated profile reached stable authority")
	}
	// An unusable state still does not reach platform retirement in isolation.
	if err := retireAutostartForProfile(""); err != nil {
		t.Fatalf("isolated retirement = %v", err)
	}
}

func TestStableProfileKeepsLegacyAutostartAuthority(t *testing.T) {
	t.Setenv("DSHKER_SECRET_NAMESPACE", "")
	authority := &observedAutostart{}
	if got := autostartForProfile(authority); got != authority {
		t.Fatal("stable authority was replaced")
	}
	if got := autostartForProfile(nil); got != nil {
		t.Fatal("missing stable authority was invented")
	}
}

func TestIsolatedAutostartCLIRefusesBeforePlatformAndStateAccess(t *testing.T) {
	t.Setenv("DSHKER_SECRET_NAMESPACE", "profile-unit-test")
	for _, verb := range []string{"status", "enable", "disable"} {
		var stdout, stderr bytes.Buffer
		code := runAutostart([]string{verb, "--state", "relative-and-never-opened"}, &stdout, &stderr)
		if code == 0 || strings.TrimSpace(stderr.String()) != "p2p.autostart_unsupported" || stdout.Len() != 0 {
			t.Fatalf("%s = %d, %q, %q", verb, code, stdout.String(), stderr.String())
		}
	}
}
