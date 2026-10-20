//go:build live

package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

//go:embed testdata/workbench-network-fault.ps1
var recoveryFirewallScript []byte

type recoveryFirewallProof struct {
	ID                    string    `json:"id"`
	Operation             string    `json:"operation"`
	Direction             string    `json:"direction"`
	CorePID               int       `json:"corePID"`
	IdentityVerified      bool      `json:"identityVerified"`
	ActiveRules           int       `json:"activeRules"`
	RuleNames             []string  `json:"ruleNames"`
	RequestedMilliseconds int64     `json:"requestedMilliseconds"`
	HeldMilliseconds      int64     `json:"heldMilliseconds"`
	ReleaseStartedAt      time.Time `json:"releaseStartedAt"`
	ReleasedAt            time.Time `json:"releasedAt"`
	ErrorCode             string    `json:"errorCode"`
	CleanupError          string    `json:"cleanupError"`
	WatchdogDeadline      time.Time `json:"watchdogDeadline"`
	CleanupConfirmed      bool      `json:"cleanupConfirmed"`
}

type recoveryFirewall struct {
	mu       sync.Mutex
	root     string
	script   string
	plan     string
	closed   bool
	last     recoveryFirewallProof
	logger   func(recoveryFirewallProof)
	id       string
	corePID  int
	deadline time.Time
}

func recoveryStartFirewall(t *testing.T, ctx context.Context, corePath string, corePID, parentPID int) *recoveryFirewall {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Fatal("test.firewall_windows_required")
	}
	if err := recoveryFirewallScope(corePath, os.TempDir(), corePID, parentPID); err != nil {
		t.Fatal(err)
	}
	file, err := os.ReadFile(corePath)
	must(t, err)
	coreHash := sha256.Sum256(file)
	scriptHash := sha256.Sum256(recoveryFirewallScript)
	var random [16]byte
	_, err = rand.Read(random[:])
	must(t, err)
	id := hex.EncodeToString(random[:])
	// Not t.TempDir: a failed cleanup must retain the independent task's files.
	root, err := os.MkdirTemp(os.TempDir(), "dshker-udp-fault-")
	must(t, err)
	// Task Scheduler publishes second-granularity trigger boundaries. Truncate
	// toward an earlier deadline, never allow a rounded trigger to miss expiry.
	controller := &recoveryFirewall{root: root, script: filepath.Join(root, "controller.ps1"), plan: filepath.Join(root, "plan.json"), id: id, corePID: corePID, deadline: time.Now().UTC().Add(90 * time.Second).Truncate(time.Second)}
	controller.logger = func(proof recoveryFirewallProof) {
		encoded, err := json.Marshal(proof)
		if err != nil {
			t.Error("test.firewall_proof_encode_failed")
			return
		}
		t.Logf("network-firewall-proof %s", encoded)
	}
	must(t, os.WriteFile(controller.script, recoveryFirewallScript, 0600))
	plan := map[string]any{
		"version": 1, "id": id, "root": root, "script": controller.script,
		"scriptHash": hex.EncodeToString(scriptHash[:]), "executable": corePath,
		"coreHash": hex.EncodeToString(coreHash[:]), "corePID": corePID, "parentPID": parentPID,
		"creationUtc": "", "deadlineUtc": controller.deadline.Format(time.RFC3339Nano),
		"taskState": "none", "ownedRules": []string{}, "pendingRules": []string{},
	}
	encoded, err := json.Marshal(plan)
	must(t, err)
	must(t, os.WriteFile(controller.plan, encoded, 0600))
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := controller.Close(cleanup); err != nil {
			t.Errorf("independent firewall cleanup unresolved; retained %s: %v", root, err)
		}
	})
	_, err = controller.invoke(ctx, "setup", "none", 0)
	if err != nil {
		t.Fatal(err)
	}
	return controller
}

func recoveryFirewallScope(executable, temp string, corePID, parentPID int) error {
	if !filepath.IsAbs(executable) || !filepath.IsAbs(temp) || corePID <= 0 || parentPID <= 0 || corePID == parentPID {
		return errors.New("test.firewall_explicit_identity_required")
	}
	if strings.ContainsAny(executable, "\r\n\x00*?[]") || filepath.Base(executable) != "dshkerd.exe" {
		return errors.New("test.firewall_invalid_executable")
	}
	directory := filepath.Dir(filepath.Clean(executable))
	if filepath.Dir(directory) != filepath.Clean(temp) || !strings.HasPrefix(filepath.Base(directory), "dshker-recovery-cross-") {
		return errors.New("test.firewall_unowned_executable")
	}
	return nil
}

func (controller *recoveryFirewall) Cut(ctx context.Context, direction string, duration time.Duration) (recoveryFirewallProof, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.closed || (direction != "inbound" && direction != "outbound" && direction != "both") || (duration != 3*time.Second && duration != 35*time.Second) {
		return recoveryFirewallProof{}, errors.New("test.firewall_invalid_fault")
	}
	return controller.invoke(ctx, "cut", direction, duration.Milliseconds())
}

func (controller *recoveryFirewall) Close(ctx context.Context) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.closed {
		return nil
	}
	proof, err := controller.invoke(ctx, "close", "none", 0)
	if err != nil || proof.ActiveRules != 0 || !proof.CleanupConfirmed {
		return errors.Join(err, errors.New("test.firewall_cleanup_unconfirmed"))
	}
	controller.closed = true
	// Exact MkdirTemp root only, after rules and scheduled task were retired.
	return os.RemoveAll(controller.root)
}

func recoveryFirewallArguments(script, plan, operation, direction string, milliseconds int64) []string {
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	source := "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
		"& ([ScriptBlock]::Create([IO.File]::ReadAllText(" + quote(script) + ")))" +
		" -PlanPath " + quote(plan) + " -Operation " + quote(operation) +
		" -Direction " + quote(direction) + fmt.Sprintf(" -Milliseconds %d", milliseconds)
	units := utf16.Encode([]rune(source))
	data := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(data[index*2:], unit)
	}
	return []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(data)}
}

func (controller *recoveryFirewall) invoke(ctx context.Context, operation, direction string, milliseconds int64) (recoveryFirewallProof, error) {
	budget := 25*time.Second + time.Duration(milliseconds)*time.Millisecond
	bounded, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	command := exec.CommandContext(bounded, "powershell.exe", recoveryFirewallArguments(controller.script, controller.plan, operation, direction, milliseconds)...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	data, commandErr := command.Output()
	proof, err := controller.decodeReceipt(bytes.TrimSpace(data), operation, direction, milliseconds)
	if err != nil {
		return proof, fmt.Errorf("test.firewall_invalid_receipt operation=%s command=%v decode=%v stderr=%s", operation, commandErr, err, stderr.String())
	}
	controller.last = proof
	controller.logger(proof)
	if commandErr != nil || proof.ErrorCode != "" || proof.CleanupError != "" || proof.ActiveRules != 0 {
		return proof, fmt.Errorf("test.firewall_failed operation=%s code=%s cleanup=%s command=%v", operation, proof.ErrorCode, proof.CleanupError, commandErr)
	}
	return proof, nil
}

func (controller *recoveryFirewall) decodeReceipt(data []byte, operation, direction string, milliseconds int64) (recoveryFirewallProof, error) {
	var proof recoveryFirewallProof
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return proof, err
	}
	required := []string{"id", "operation", "direction", "corePID", "identityVerified", "activeRules", "ruleNames", "requestedMilliseconds", "heldMilliseconds", "releaseStartedAt", "releasedAt", "errorCode", "cleanupError", "watchdogDeadline", "cleanupConfirmed"}
	if len(fields) != len(required) {
		return proof, errors.New("test.firewall_receipt_shape")
	}
	for _, name := range required {
		value, found := fields[name]
		if !found || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return proof, errors.New("test.firewall_receipt_missing_field:" + name)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proof); err != nil {
		return proof, err
	}
	prefix := "DSHKer-UDPFault-" + controller.id
	if proof.ID != controller.id || proof.CorePID != controller.corePID || proof.Operation != operation || proof.Direction != direction ||
		proof.RequestedMilliseconds != milliseconds || !proof.WatchdogDeadline.Equal(controller.deadline) ||
		!slices.Equal(proof.RuleNames, []string{prefix + "-in", prefix + "-out", prefix + "-proof"}) {
		return proof, errors.New("test.firewall_receipt_identity")
	}
	if proof.ErrorCode == "" && proof.CleanupError == "" {
		if proof.ActiveRules != 0 || ((operation == "setup" || operation == "cut") && !proof.IdentityVerified) || (operation == "close" && !proof.CleanupConfirmed) {
			return proof, errors.New("test.firewall_receipt_unconfirmed")
		}
		if operation == "cut" && (proof.HeldMilliseconds < milliseconds || proof.ReleaseStartedAt.IsZero() || proof.ReleasedAt.Before(proof.ReleaseStartedAt)) {
			return proof, errors.New("test.firewall_receipt_invalid_duration")
		}
	}
	return proof, nil
}
