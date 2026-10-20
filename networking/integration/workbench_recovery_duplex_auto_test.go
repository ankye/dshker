//go:build live

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peersession"
)

// Every cycle follows the full real idle interval. Both repairs belong to
// production auto-connect owners; test-control reads never ask either to connect.
func recoveryDuplexAutoCycles(t *testing.T, ctx context.Context, config recoveryCrossConfig, f *realCoordinator, core *localrpc.Peer, events <-chan peersession.State, owner *recoveryWindowsOwner, windows *recoveryWindowsRuntime, browser *recoveryBrowser, workspace recoveryWorkspace, session string, first peersession.Connected, previous peersession.State, reverse *recoveryReverseStatus, stream *recoveryWS, seen map[string]bool) (peersession.State, *recoveryReverseStatus, *recoveryWS) {
	t.Helper()
	for cycle := 1; cycle <= config.Cycles; cycle++ {
		fault, cancel := context.WithTimeout(ctx, 25*time.Second)
		started := time.Now()
		recoveryCrossControl(t, fault, config, "/invalidate-runtime")
		waitDisconnected(t, fault, events, previous.AttemptID)
		browser.detached(t, fault)
		assertRecoveryStreamClosed(t, fault, stream)
		reverse = recoveryReverseUnchanged(t, fault, config, reverse, "forward-interrupted")
		current := recoveryState(t, fault, events, previous.PairID, previous.Generation, "ready")
		recoveryForwardFresh(t, seen, current)
		if current.RuntimeGeneration != 1 || recoveryEntry(t, fault, core, f, current) != first.URL {
			t.Fatal("automatic forward cycle changed its original gateway or runtime")
		}
		stream = browser.readback(t, fault, workspace, session)
		reverse = recoveryReverseUnchanged(t, fault, config, reverse, "forward-recovered")
		forwardElapsed := time.Since(started)
		if fault.Err() != nil || forwardElapsed > 25*time.Second {
			t.Fatal("automatic forward recovery exceeded the original fault-to-readback 25s budget")
		}
		cancel()
		previous = current
		resumeBaseline := owner.resumes.Load()
		fault, cancel = context.WithTimeout(ctx, 25*time.Second)
		started = time.Now()
		recoveryCall(t, fault, core, f, "runtime.invalidate", map[string]any{"generation": windows.binding.Generation})
		recoveryForwardUnchanged(t, fault, core, f, browser, workspace, session, stream, previous, first.URL, "reverse-interrupted")
		next := recoveryRequireReverse(t, recoveryCrossControl(t, fault, config, "/reverse-await-ready"), "ready", windows.binding.Generation)
		recoveryReverseAdvanced(t, reverse, next)
		reverse = next
		windows.assertRunning(t, fault, core)
		if owner.opens.Load() != 1 || owner.resumes.Load() <= resumeBaseline {
			t.Fatal("automatic reverse cycle used cold open or omitted bind-only resume")
		}
		recoveryForwardUnchanged(t, fault, core, f, browser, workspace, session, stream, previous, first.URL, "reverse-recovered")
		reverseElapsed := time.Since(started)
		if fault.Err() != nil || reverseElapsed > 25*time.Second {
			t.Fatal("automatic reverse recovery exceeded the original fault-to-readback 25s budget")
		}
		cancel()
		t.Logf("duplex-recovery-cycle cycle=%d forwardAttempt=%s forwardGeneration=%d forwardElapsedMs=%d reverseAttempt=%s reverseGeneration=%d reverseElapsedMs=%d sameGateways=true sameCookieSession=true trigger=production-autoconnect-engine", cycle, previous.AttemptID, previous.Generation, forwardElapsed.Milliseconds(), reverse.State.AttemptID, reverse.State.Generation, reverseElapsed.Milliseconds())
	}
	return previous, reverse, stream
}
