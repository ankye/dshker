//go:build windows || (native_secrets && (darwin || linux))

package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/runtimeowner"
	"github.com/ankye/dshker/networking/internal/secret"
)

// This adds the actual platform secret provider to the same production-core
// crash/recovery path. It writes only random regression keys in a unique test
// namespace; the current formal credential store is never opened.
func TestProductionCoreOwnerRecoveryPreservesNativeSecrets(t *testing.T) {
	recoveryNamespace(t)
	binary := isolationCoreBinary(t)
	for _, mode := range []string{"desktop", "headless"} {
		t.Run(mode, func(t *testing.T) {
			data := recoverySeedRecords(t)
			store, err := secret.OpenNamespace(data.dataRoot, os.Getenv("DSHKER_SECRET_NAMESPACE"))
			must(t, err)
			keys := map[string][]byte{}
			for _, key := range []string{"machine.device-key", "account.session"} {
				value := make([]byte, 32)
				_, err := rand.Read(value)
				must(t, err)
				must(t, store.Set(key, value))
				keys[key] = value
			}
			t.Cleanup(func() {
				for key := range keys {
					if err := store.Delete(key); err != nil {
						t.Errorf("regression namespace cleanup failed: %v", err)
					}
				}
			})
			credentialFile := filepath.Join(data.dataRoot, "credentials.dshkerd."+os.Getenv("DSHKER_SECRET_NAMESPACE")+".json")
			var ciphertext []byte
			if runtime.GOOS == "windows" {
				ciphertext, err = os.ReadFile(credentialFile)
				must(t, err)
			}
			config := runtimeowner.Config{
				Executable: binary, StateRoot: stateDirectoryForCLI(t), DataRoot: data.dataRoot, CatalogRoot: data.catalogRoot,
			}
			owner, err := runtimeowner.Open(context.Background(), config)
			must(t, err)
			t.Cleanup(func() {
				if identity, err := runtimeowner.InspectIdentity(config); err == nil && identity == owner.Identity() {
					cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					if err := owner.Shutdown(cleanup); err != nil {
						t.Errorf("original secret-test authority cleanup failed: %v", err)
					}
				}
				_ = owner.Close()
			})
			before := recoveryCaptureOwner(t, config.StateRoot)
			recoveryKillExactIdleOwner(t, config, owner)
			core := isolationBootCore(t, binary, config.StateRoot, data.catalogRoot, mode, data.dataRoot)
			t.Cleanup(func() {
				if !core.stopped {
					recoveryStopCore(t, core)
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			for key, expected := range keys {
				coreSecretAssert(t, ctx, core.peer, key, string(expected))
				actual, err := store.Get(key)
				must(t, err)
				if !bytes.Equal(actual, expected) {
					t.Fatal("runtime recovery replaced native account or machine credentials")
				}
			}
			if ciphertext != nil {
				after, err := os.ReadFile(credentialFile)
				must(t, err)
				if sha256.Sum256(ciphertext) != sha256.Sum256(after) {
					t.Fatal("read-only owner recovery rewrote native credential ciphertexts")
				}
			}
			data.assertReadback(t, ctx, core)
			recoveryAssertArchive(t, config.StateRoot, before)
			recoveryStopCore(t, core)
		})
	}
}
