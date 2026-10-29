//go:build windows || (native_secrets && (darwin || linux))

package integration

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
	"github.com/ankye/dshker/networking/internal/secret"
)

// Run the real packaged-core entry in both compositions. The same data root
// makes a provider that ignores the explicit namespace fail this regression,
// and the unique regression services never address existing user credentials.
func TestProductionCoreSecretProfileIsolation(t *testing.T) {
	binary := isolationCoreBinary(t)
	for _, mode := range []string{"desktop", "headless"} {
		t.Run(mode, func(t *testing.T) {
			identifier := make([]byte, 16)
			must(t, randomSecretIdentity(identifier))
			prefix := "regression-" + hex.EncodeToString(identifier)
			dataRoot := t.TempDir()
			boot := func(namespace string) *isolationCore {
				t.Setenv("DSHKER_SECRET_NAMESPACE", namespace)
				state, catalogRoot := stateDirectoryForCLI(t), t.TempDir()
				active := isolationBootCore(t, binary, state, catalogRoot, mode, dataRoot)
				// Windows has no graceful signal for headless serve. Authenticate
				// its exact test-owned runtime before stopping the core, then join
				// it explicitly so a fault test never strands an authority.
				owner, err := runtimeowner.Open(context.Background(), runtimeowner.Config{
					Executable: binary, StateRoot: state, DataRoot: dataRoot, CatalogRoot: catalogRoot,
				})
				must(t, err)
				t.Cleanup(func() {
					active.stop(t)
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					// A desktop normal exit already joins the same owner; only a
					// retained record still admits this cleanup operation.
					if _, err := os.Stat(filepath.Join(state, "runtime-owner", "owner.json")); err == nil {
						must(t, owner.Shutdown(ctx))
					}
					must(t, owner.Close())
				})
				return active
			}
			first, second := boot(prefix+"-a"), boot(prefix+"-b")
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			for _, key := range []string{"machine.device-key", "account.session"} {
				key := key
				t.Cleanup(func() {
					for _, suffix := range []string{"-a", "-b"} {
						store, err := secret.OpenNamespace(dataRoot, prefix+suffix)
						if err != nil {
							t.Errorf("isolated cleanup admission failed: %v", err)
							continue
						}
						if err := store.Delete(key); err != nil {
							t.Errorf("isolated cleanup failed: %v", err)
						}
					}
				})
				original := "first-profile:" + key
				replacement := "second-profile:" + key
				coreSecretSet(t, ctx, first.peer, key, original)
				if _, err := second.peer.Call(ctx, "core.secret_get", map[string]string{"key": key}); err == nil || err.Error() != "p2p.secret_missing" {
					t.Fatalf("%s core borrowed another profile credential: %v", mode, err)
				}
				callCore(t, ctx, second.peer, "core.secret_delete", map[string]string{"key": key})
				coreSecretAssert(t, ctx, first.peer, key, original)
				coreSecretSet(t, ctx, second.peer, key, replacement)
				coreSecretAssert(t, ctx, first.peer, key, original)
				coreSecretAssert(t, ctx, second.peer, key, replacement)
				callCore(t, ctx, second.peer, "core.secret_delete", map[string]string{"key": key})
				coreSecretAssert(t, ctx, first.peer, key, original)
				if _, err := second.peer.Call(ctx, "core.secret_get", map[string]string{"key": key}); err == nil || err.Error() != "p2p.secret_missing" {
					t.Fatalf("isolated deletion did not remain scoped: %v", err)
				}
				// Remove only this random regression service's known logical key.
				callCore(t, ctx, first.peer, "core.secret_delete", map[string]string{"key": key})
			}
		})
	}
}

func randomSecretIdentity(value []byte) error {
	_, err := rand.Read(value)
	return err
}

func coreSecretSet(t *testing.T, ctx context.Context, peer *localrpc.Peer, key, value string) {
	t.Helper()
	callCore(t, ctx, peer, "core.secret_set", map[string]string{
		"key": key, "value": base64.StdEncoding.EncodeToString([]byte(value)),
	})
}

func coreSecretAssert(t *testing.T, ctx context.Context, peer *localrpc.Peer, key, expected string) {
	t.Helper()
	raw := callCore(t, ctx, peer, "core.secret_get", map[string]string{"key": key})
	var reply struct {
		Value string `json:"value"`
	}
	must(t, json.Unmarshal(raw, &reply))
	if reply.Value != base64.StdEncoding.EncodeToString([]byte(expected)) {
		t.Fatalf("production core read another namespace's %s", key)
	}
}
