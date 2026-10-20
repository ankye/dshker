package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// The headless callback owns only Binding, not a Start capability.
type resumeStatusSource struct {
	view  harnessruntime.LaunchView
	reads int
}

func (source *resumeStatusSource) Binding(ctx context.Context, subject string) (runtimebridge.Binding, error) {
	source.reads++
	if err := ctx.Err(); err != nil {
		return runtimebridge.Binding{}, err
	}
	if subject != "subject_main" || source.view.State != harnessruntime.StateRunning || source.view.URL == "" {
		return runtimebridge.Binding{}, core.ErrRuntimeUnavailable
	}
	return runtimebridge.Binding{Generation: 1, URL: source.view.URL}, nil
}

func TestHeadlessResumeOnlyReadsRunningBinding(t *testing.T) {
	source := &resumeStatusSource{view: harnessruntime.LaunchView{LaunchID: "resume-launch", State: harnessruntime.StateRunning, URL: "http://127.0.0.1:1234/?token=headless-resume-test"}}
	main := headlessMain{binding: &core.RuntimeBinding{Runtime: source, Subject: "subject_main"}}
	data, err := main.Call(context.Background(), "runtime.resume", struct{}{})
	var binding runtimebridge.Binding
	if err != nil || json.Unmarshal(data, &binding) != nil || binding.URL != source.view.URL || binding.Generation != 1 || source.reads != 1 {
		t.Fatalf("running resume did not read the current binding: %v", err)
	}
	for _, state := range []string{harnessruntime.StateStopped, harnessruntime.StateFailed, harnessruntime.StateStarting} {
		source.view.State = state
		for attempt := 0; attempt < 3; attempt++ {
			if _, err := main.Call(context.Background(), "runtime.resume", struct{}{}); err == nil || err.Error() != "p2p.runtime_unavailable" {
				t.Fatalf("%s resume did not refuse without starting: %v", state, err)
			}
			if source.view.State != state {
				t.Fatal("read-only resume changed runtime state")
			}
		}
	}
}
