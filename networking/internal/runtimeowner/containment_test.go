package runtimeowner

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
)

// Test-only executable mode: a detached grandchild exercises kernel process
// containment without adding a fixture branch to any production entry point.
func runContainmentTestChild(arguments []string) bool {
	if len(arguments) < 3 || arguments[0] != "--containment-test-child" {
		return false
	}
	mode, directory := arguments[1], arguments[2]
	identity, err := processIdentityAt(os.Getpid())
	if err != nil {
		os.Exit(8)
	}
	raw, _ := json.Marshal(identity)
	if mode == "leaf" || mode == "leaf-default" {
		if mode == "leaf" {
			signal.Ignore(syscall.SIGTERM)
		}
		if os.WriteFile(filepath.Join(directory, "leaf.json"), raw, 0o600) != nil {
			os.Exit(9)
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		os.Exit(10)
	}
	leafMode := "leaf"
	if mode == "root-running-clean-leaf" {
		leafMode = "leaf-default"
	}
	child := exec.Command(executable, "--containment-test-child", leafMode, directory)
	if runtime.GOOS == "windows" {
		child.SysProcAttr = detachedAttributes()
	}
	if child.Start() != nil {
		os.Exit(11)
	}
	if os.WriteFile(filepath.Join(directory, "root.json"), raw, 0o600) != nil {
		os.Exit(12)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(directory, "leaf.json")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			os.Exit(13)
		}
		time.Sleep(5 * time.Millisecond)
	}
	fmt.Println("dsh web: http://127.0.0.1:3088/?token=test-only-containment")
	if mode == "root-exits" {
		return true
	}
	for {
		time.Sleep(time.Hour)
	}
}

func containmentRequest(t *testing.T, config Config, subject, launch, mode, suffix string) (harnessruntime.LaunchRequest, string) {
	t.Helper()
	directory := filepath.Join(config.StateRoot, suffix)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return harnessruntime.LaunchRequest{
		LaunchID: launch, SubjectID: subject, Directory: config.StateRoot,
		Profile: harnessruntime.ProfilePnpm, PnpmExecutable: executable,
		PnpmPrefixArguments:  []string{"--containment-test-child", mode, directory},
		DiagnosticsPatchPath: filepath.Join(config.StateRoot, "overlay.yml"),
		Port:                 harnessruntime.AutoPort(), LogPath: filepath.Join(directory, "child.log"),
	}, directory
}

func readProbeProcess(t *testing.T, directory, name string) processIdentity {
	t.Helper()
	var identity processIdentity
	waitOwner(t, "owned containment process did not publish identity", func() bool {
		raw, err := os.ReadFile(filepath.Join(directory, name+".json"))
		return err == nil && json.Unmarshal(raw, &identity) == nil && validRecordedProcess(identity)
	})
	return identity
}

func waitProbeExit(t *testing.T, identity processIdentity) {
	t.Helper()
	waitOwner(t, "exact owned containment process survived", func() bool { gone, err := recordedProcessExited(identity); return err == nil && gone })
}
