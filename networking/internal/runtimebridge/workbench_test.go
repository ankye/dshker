package runtimebridge

import (
	"errors"
	"testing"
)

func TestWorkbenchRefusalAdmitsOnlyOwningTypedCodes(t *testing.T) {
	for cause, want := range map[string]string{
		"runtime.worktree_invalid":                         "runtime.worktree_invalid",
		"p2p.pair_unauthorized":                            "p2p.pair_unauthorized",
		"unexpected library sentence with private details": "p2p.runtime_unavailable",
	} {
		if code := workbenchRefusal(errors.New(cause)); code != want {
			t.Fatalf("workbench refusal = %q, want admitted code %q", code, want)
		}
	}
}
