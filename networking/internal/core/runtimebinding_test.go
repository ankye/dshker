package core

import (
	"errors"
	"testing"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
)

// statusSource is the child authority a binding reads, standing in for the
// supervisor so the generation rule can be driven exactly.
type statusSource struct {
	view    harnessruntime.LaunchView
	present bool
}

func (source statusSource) Status(string) (harnessruntime.LaunchView, bool) {
	return source.view, source.present
}

func running(launchID, url string) harnessruntime.LaunchView {
	return harnessruntime.LaunchView{LaunchID: launchID, State: harnessruntime.StateRunning, URL: url}
}

// TestRuntimeBindingNamesOneGenerationPerChild pins the rule a peer depends on:
// one running child is one generation, a replaced child is the next one, and no
// child is a refusal rather than a stale address.
func TestRuntimeBindingNamesOneGenerationPerChild(t *testing.T) {
	binding := &RuntimeBinding{Subject: "subject_main"}
	if _, err := binding.Binding(); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("no authority = %v", err)
	}

	source := statusSource{present: false}
	binding.Runtime = source
	if _, err := binding.Binding(); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("no child = %v", err)
	}

	source = statusSource{present: true, view: running("launch_1", "http://127.0.0.1:3099/?token=one")}
	binding.Runtime = source
	first, err := binding.Binding()
	if err != nil || first.Generation != 1 || first.URL != source.view.URL {
		t.Fatalf("first = %+v (%v)", first, err)
	}
	// Asking twice about the same child is the same generation: a peer that
	// reconnects must not be told its proxy target changed when it did not.
	again, err := binding.Binding()
	if err != nil || again != first {
		t.Fatalf("again = %+v (%v)", again, err)
	}

	// A child that is starting, stopped or failed has no address to bind.
	for _, state := range []string{harnessruntime.StateStarting, harnessruntime.StateStopped, harnessruntime.StateFailed} {
		source.view.State = state
		binding.Runtime = source
		if _, err := binding.Binding(); !errors.Is(err, ErrRuntimeUnavailable) {
			t.Fatalf("%s = %v", state, err)
		}
	}

	// The same child announcing a different address, and a different child, are
	// both a new generation.
	source.view = running("launch_1", "http://127.0.0.1:3098/?token=two")
	binding.Runtime = source
	second, err := binding.Binding()
	if err != nil || second.Generation != 2 || second.URL != source.view.URL {
		t.Fatalf("relaunched on a new address = %+v (%v)", second, err)
	}
	source.view = running("launch_2", "http://127.0.0.1:3099/?token=one")
	binding.Runtime = source
	third, err := binding.Binding()
	if err != nil || third.Generation != 3 {
		t.Fatalf("replaced child = %+v (%v)", third, err)
	}
}
