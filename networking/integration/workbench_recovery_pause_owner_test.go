//go:build live

package integration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"errors"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// Each input is generated for this native preflight. No installed roots,
// account, runtime or home are read or substituted.
type recoveryPauseOrphanConfig struct {
	Binary     string `json:"binary"`
	TestBinary string `json:"testBinary"`
	State      string `json:"state"`
	Data       string `json:"data"`
	Catalog    string `json:"catalog"`
	Roots      string `json:"roots"`
	Home       string `json:"home"`
}

func recoveryPauseCoreInputs(t *testing.T, binary string) recoveryPauseOrphanConfig {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	now := time.Now()
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, public, private)
	must(t, err)
	roots := filepath.Join(t.TempDir(), "pause-ca.pem")
	writeRootsPEM(t, roots, der)
	return recoveryPauseOrphanConfig{Binary: binary, State: stateDirectoryForCLI(t), Data: t.TempDir(), Catalog: t.TempDir(), Roots: roots, Home: t.TempDir()}
}

func recoveryPauseCoreCommand(config recoveryPauseOrphanConfig) (*exec.Cmd, error) {
	if !filepath.IsAbs(config.Home) || filepath.Clean(config.Home) != config.Home {
		return nil, errors.New("test.pause_explicit_home_required")
	}
	info, err := os.Lstat(config.Home)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("test.pause_explicit_home_unavailable")
	}
	command := exec.Command(config.Binary, "serve", "--state", config.State, "--data", config.Data, "--catalog", config.Catalog, "--roots", config.Roots)
	if _, err := recoveryOwnerConfiguration(command); err != nil {
		return nil, err
	}
	for _, value := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(value, "=", 2)[0])
		if name != "DSH_HOME" && !strings.HasPrefix(name, "PION_LOG_") && !strings.HasPrefix(name, "PIONS_LOG_") && name != "DSHKER_TURN_DEBUG" {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "DSH_HOME="+config.Home, "PION_LOG_WARN=all", "PION_LOG_INFO=ice,pc")
	return command, nil
}

func recoveryPauseCaptureOwner(command *exec.Cmd, corePID int, expected *runtimeowner.Identity) (*recoveryOwnerTeardown, error) {
	config, err := recoveryOwnerConfiguration(command)
	if err != nil {
		return nil, err
	}
	environment := append([]string(nil), command.Env...)
	identity, err := runtimeowner.InspectIdentityForEnvironment(config, environment)
	if err != nil {
		return nil, err
	}
	if expected != nil && identity != *expected {
		return nil, errors.New("test.pause_original_owner_identity_mismatch")
	}
	held, err := recoveryHoldExactProcess(identity.PID, corePID, command.Path)
	if err != nil {
		return nil, err
	}
	if err := recoveryAdmitOwnerIdentity(identity, identity.Config, held.Proof(), corePID); err != nil {
		_ = held.Close()
		return nil, err
	}
	return &recoveryOwnerTeardown{identity: identity, held: held, attach: func(ctx context.Context) (recoveryOwnerShutdownClient, error) {
		return runtimeowner.AttachExisting(ctx, config, environment, identity)
	}}, nil
}

func recoveryPauseStartOwnedCore(t *testing.T, config recoveryPauseOrphanConfig) (*process, *recoveryOwnerTeardown) {
	t.Helper()
	recoveryRequireIsolatedCore(t)
	must(t, recoveryPauseScope(config.Binary, os.TempDir(), 2, 1))
	command, err := recoveryPauseCoreCommand(config)
	must(t, err)
	var owner *recoveryOwnerTeardown
	captureAttempted := false
	// Installed before readiness: partial startup still owes authenticated owner
	// cleanup. A missing owner identity is an explicit cleanup failure.
	daemon := recoveryLaunchServe(t, command, func() {
		if owner == nil {
			if captureAttempted {
				t.Error("test.pause_original_owner_was_not_registered")
				return
			}
			captureAttempted = true
			var err error
			owner, err = recoveryPauseCaptureOwner(command, command.Process.Pid, nil)
			if err != nil {
				t.Errorf("test.pause_startup_owner_cleanup_failed: %v", err)
				return
			}
		}
		owner.finish(t)
	})
	captureAttempted = true
	owner = recoveryRegisterOwnerTeardown(t, command)
	return daemon, owner
}
