//go:build live

package integration

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type recoveryPauseWaitTestProcess struct{ closed, terminated int }

func (*recoveryPauseWaitTestProcess) Proof() recoveryProcessProof { return recoveryProcessProof{} }
func (*recoveryPauseWaitTestProcess) Alive() (bool, error)        { return false, nil }
func (process *recoveryPauseWaitTestProcess) Close() error {
	process.closed++
	return nil
}
func (process *recoveryPauseWaitTestProcess) Terminate(context.Context) error {
	process.terminated++
	return errors.New("test.unexpected_pause_wait_termination")
}

// Pure completion/receipt ownership only. No process, native API, credential
// provider, core or Harness is started by these tests.
func TestWorkbenchRecoveryPauseReceiptWaitPreservesChildExitForCleanup(t *testing.T) {
	for _, name := range []string{"orphan-ready.json", "orphan-paused.json"} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root := t.TempDir()
				held := &recoveryPauseWaitTestProcess{}
				child := &recoveryPauseChild{process: held, done: make(chan struct{})}
				original := errors.New("original child Wait exit status 2")
				ctx, cancel := context.WithTimeout(context.Background(), 85*time.Second)
				defer cancel()
				started := time.Now()
				result := make(chan error, 1)
				go func() {
					var receipt recoveryPauseProof
					result <- child.waitReceipt(ctx, root, name, &receipt)
				}()
				synctest.Wait()
				child.err = original // The sole Wait owner publishes before close.
				close(child.done)
				err := <-result
				if !errors.Is(err, original) || !strings.Contains(err.Error(), "test.pause_runner_exited_before_receipt: "+name) || time.Since(started) != 0 {
					t.Fatal("runner exit lost its original cause/stage or waited for a polling/deadline tick", err, time.Since(started))
				}
				run := &recoveryPauseRun{plan: recoveryPausePlan{Root: root, ID: "owned-test-nonce"}, controller: child}
				must(t, run.finish(ctx)) // Existing cleanup sees the same completion.
				select {
				case <-child.done:
				default:
					t.Fatal("receipt observation consumed cleanup's completion")
				}
				if child.err != original || held.closed != 1 || held.terminated != 0 {
					t.Fatal("cleanup lost the stored exit or restarted/terminated its completed owner", child.err, held)
				}
			})
		})
	}
}

func TestWorkbenchRecoveryPauseReceiptWaitRequiresLiveOriginalChildAndStrictReceipt(t *testing.T) {
	for _, name := range []string{"valid", "exited-with-receipt", "clean-early-exit", "invalid", "cancelled", "cancelled-and-exited", "missing-owner"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			_, proof, _ := recoveryPausePurePlan()
			child := &recoveryPauseChild{done: make(chan struct{})}
			original := errors.New("original runner exit")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch name {
			case "valid", "exited-with-receipt":
				must(t, recoveryPauseWrite(root, "orphan-paused.json", proof))
				if name == "exited-with-receipt" {
					child.err = original
					close(child.done)
				}
			case "clean-early-exit":
				close(child.done)
			case "invalid":
				must(t, os.WriteFile(root+string(os.PathSeparator)+"orphan-paused.json", []byte(`{`), 0o600))
			case "cancelled":
				cancel()
			case "cancelled-and-exited":
				cancel()
				child.err = original
				close(child.done)
			case "missing-owner":
				child = nil
			}
			var receipt recoveryPauseProof
			err := child.waitReceipt(ctx, root, "orphan-paused.json", &receipt)
			if name == "valid" {
				if err != nil || receipt != proof {
					t.Fatal("live exact child lost its strict receipt", receipt, err)
				}
			} else if err == nil {
				t.Fatal("dead/missing child, invalid receipt or cancelled wait was admitted", name)
			}
			if (name == "clean-early-exit" || name == "exited-with-receipt" || name == "cancelled-and-exited") && !strings.Contains(err.Error(), "test.pause_runner_exited_before_receipt: orphan-paused.json") {
				t.Fatal("early exit lost its named stage", err)
			}
			if name == "cancelled-and-exited" && (!errors.Is(err, original) || !errors.Is(err, context.Canceled)) {
				t.Fatal("an expired outer wait masked the already-published child exit", err)
			}
		})
	}
}
