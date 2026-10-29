package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// Both paths close a real authenticated desktop, wait for the production serve
// process to exit without a signal, and restart the same installation/state.
// No native credentials or global autostart authority are opened.
func TestIsolatedHeadlessDesktopExitJoinsOwnerAndRestarts(t *testing.T) {
	identifier := sha256.Sum256([]byte(t.TempDir()))
	t.Setenv("DSHKER_SECRET_NAMESPACE", "regression-handoff-"+hex.EncodeToString(identifier[:]))
	binary := isolationCoreBinary(t)
	for _, mode := range []string{"handoff", "disconnected"} {
		t.Run(mode, func(t *testing.T) {
			state, catalogRoot := stateDirectoryForCLI(t), t.TempDir()
			config := runtimeowner.Config{Executable: binary, StateRoot: state, CatalogRoot: catalogRoot}
			ownerPath := filepath.Join(state, "runtime-owner", "owner.json")
			var previousRecord [sha256.Size]byte
			for generation := 0; generation < 2; generation++ {
				active := isolationBootCore(t, binary, state, catalogRoot, "headless")
				t.Cleanup(func() {
					active.stop(t)
					if _, err := os.Stat(ownerPath); os.IsNotExist(err) {
						return
					}
					// Only a failed regression can leave this exact isolated owner.
					// Join it through its authenticated production identity; never
					// discard an owner record or kill an unrelated process.
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					owner, err := runtimeowner.Open(ctx, config)
					if err != nil {
						t.Errorf("isolated owner cleanup admission: %v", err)
						return
					}
					defer owner.Close()
					if err := owner.Shutdown(ctx); err != nil {
						t.Errorf("isolated owner cleanup: %v", err)
					}
				})
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				record, err := os.ReadFile(ownerPath)
				must(t, err)
				currentRecord := sha256.Sum256(record)
				if generation > 0 && currentRecord == previousRecord {
					t.Fatal("restart reused an abandoned runtime-owner record")
				}
				previousRecord = currentRecord
				if _, err := runtimeowner.InspectIdentity(config); err != nil {
					t.Fatalf("fresh production runtime owner was not admitted: %v", err)
				}
				assertCoreVersion(t, callCore(t, ctx, active.peer, "core.version", struct{}{}))
				for _, method := range []string{"core.autostart_status", "core.autostart_enable", "core.autostart_disable"} {
					if _, err := active.peer.Call(ctx, method, struct{}{}); err == nil || err.Error() != "p2p.autostart_unsupported" {
						t.Fatalf("isolated public %s did not refuse system access: %v", method, err)
					}
				}
				if _, err := active.peer.Call(ctx, "core.desktop_handoff", struct{}{}); err == nil || err.Error() != "p2p.invalid_operation" {
					t.Fatalf("unattached peer could hand off the core: %v", err)
				}
				if reply := callCore(t, ctx, active.peer, "core.desktop_attach", struct{}{}); string(reply) != `{"attached":true}` {
					t.Fatalf("isolated desktop was not attached: %s", reply)
				}
				if mode == "handoff" {
					if reply := callCore(t, ctx, active.peer, "core.desktop_handoff", struct{}{}); string(reply) != `{"handoff":true}` {
						t.Fatalf("normal handoff was not acknowledged: %s", reply)
					}
					// Receipt must be readable before the attached socket closes.
					assertCoreVersion(t, callCore(t, ctx, active.peer, "core.version", struct{}{}))
				}
				active.peer.Close()
				select {
				case err := <-active.done:
					active.stopped = true
					if err != nil {
						t.Fatalf("isolated serve did not exit normally: %v", err)
					}
				case <-ctx.Done():
					t.Fatal("isolated serve remained after desktop exit")
				}
				cancel()
				if _, err := os.Stat(ownerPath); !os.IsNotExist(err) {
					t.Fatalf("normal desktop exit left a stale runtime owner: %v", err)
				}
				if _, err := os.Stat(filepath.Join(state, localrpc.EndpointFileName)); !os.IsNotExist(err) {
					t.Fatalf("normal desktop exit left a published core endpoint: %v", err)
				}
				lockCtx, lockCancel := context.WithTimeout(context.Background(), 5*time.Second)
				lock, err := localrpc.AcquireOwnerLock(lockCtx, state, true)
				lockCancel()
				must(t, err)
				must(t, lock.Release())
			}
		})
	}
}
