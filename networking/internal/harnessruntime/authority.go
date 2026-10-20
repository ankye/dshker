package harnessruntime

import (
	"context"

	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// Authority is the one runtime owner reached by either core composition. A
// transport failure is an error, never an absent launch or a cached binding.
type Authority interface {
	Start(context.Context, LaunchRequest) (LaunchView, error)
	Stop(context.Context, string) (LaunchView, error)
	Status(context.Context, string) (LaunchView, bool, error)
	Console(context.Context, int64) ([]ConsoleEntry, int64, error)
	Binding(context.Context, string) (runtimebridge.Binding, error)
}
