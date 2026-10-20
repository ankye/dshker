package core

import (
	"context"
	"errors"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/peerbroker"
)

// runtimeRoute reads an existing runtime for the SSH broker. It has no Start
// capability and never substitutes a cached address when its authority fails.
func (server Serve) runtimeRoute(subject string) peerbroker.RuntimeRoute {
	return func(ctx context.Context) (string, error) {
		owner, err := server.runtimeSupervisor()
		if err != nil {
			return "", err
		}
		view, present, err := owner.Status(ctx, subject)
		if err != nil {
			return "", err
		}
		if !present || view.State != harnessruntime.StateRunning || view.URL == "" {
			return "", errors.New("remote.runtime_unavailable")
		}
		return view.URL, nil
	}
}
