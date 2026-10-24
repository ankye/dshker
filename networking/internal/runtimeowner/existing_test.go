package runtimeowner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAttachExistingRequiresExactCapturedContextAndIdentity(t *testing.T) {
	config := ownerTestConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	created, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutdownOwner(t, created) })
	environment := append([]string(nil), os.Environ()...)
	identity, err := InspectIdentityForEnvironment(config, environment)
	if err != nil {
		t.Fatal(err)
	}
	if identity != created.Identity() {
		t.Fatal("strict environment inspection changed authenticated owner identity")
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "token") || strings.Contains(string(encoded), "socket") || strings.Contains(string(encoded), "DSH_HOME") {
		t.Fatal("safe owner identity exposed authentication or inherited environment")
	}
	attached, err := AttachExisting(ctx, config, environment, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer attached.Close()
	if attached.Created() || attached.Identity() != identity {
		t.Fatal("existing-only attachment created or replaced the owner")
	}
	wrongHome := append(append([]string(nil), environment...), "DSH_HOME=explicit-different-owner-home")
	if _, err := AttachExisting(ctx, config, wrongHome, identity); !errors.Is(err, ErrOwnerIdentityMismatch) {
		t.Fatalf("existing attachment ignored captured home context: %v", err)
	}
	if _, err := InspectIdentityForEnvironment(config, wrongHome); !errors.Is(err, ErrOwnerIdentityMismatch) {
		t.Fatalf("strict inspection ignored captured home context: %v", err)
	}
	wrongIdentity := identity
	wrongIdentity.Instance = strings.Repeat("a", 32)
	if _, err := AttachExisting(ctx, config, environment, wrongIdentity); !errors.Is(err, ErrOwnerIdentityMismatch) {
		t.Fatalf("existing attachment accepted another owner instance: %v", err)
	}
	missing := ownerTestConfig(t)
	if _, err := AttachExisting(ctx, missing, environment, identity); !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("missing owner was not explicitly refused: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(missing.StateRoot, ownerDirectory)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("existing-only attachment created an owner directory or record")
	}
}

func TestLegacyOwnerDeathRefusesReplacementAndRetainsEvidence(t *testing.T) {
	config := ownerTestConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	identity := client.Identity()
	// This reproduces an older installation that never published child-death
	// evidence. Its missing journal must not be interpreted as an empty runtime.
	if err := os.Remove(filepath.Join(config.StateRoot, ownerDirectory, recoveryFileName)); err != nil {
		t.Fatal(err)
	}
	current, err := processIdentityAt(identity.PID)
	if err != nil || current.Creation != identity.Creation {
		t.Fatal("owned test process birth changed before the explicit death case")
	}
	victim, err := os.FindProcess(identity.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer victim.Release()
	if err := victim.Kill(); err != nil {
		t.Fatal(err)
	}
	client.Close()
	waitOwner(t, "exact owned test owner did not exit", func() bool {
		current, err := processIdentityAt(identity.PID)
		return err != nil || current.Creation != identity.Creation
	})
	path := filepath.Join(identity.Config.StateRoot, ownerDirectory, recordFileName)
	record, err := readRecord(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if record.SocketDirectory != "" {
			os.Remove(record.Socket)
			os.Remove(record.SocketDirectory)
		}
	})
	if _, err := Open(ctx, config); !errors.Is(err, ErrOwnerUnavailable) {
		t.Fatalf("dead owner was silently replaced: %v", err)
	}
	retained, err := readRecord(path)
	if err != nil || retained != record {
		t.Fatal("dead owner evidence was deleted or relabeled as a new instance")
	}
}
