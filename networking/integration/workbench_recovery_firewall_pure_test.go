//go:build live

package integration

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func TestWorkbenchRecoveryFirewallRejectsMissingOrForeignReceipt(t *testing.T) {
	controller := &recoveryFirewall{id: strings.Repeat("a", 32), corePID: 1234, deadline: time.Now().UTC().Truncate(time.Millisecond)}
	prefix := "DSHKer-UDPFault-" + controller.id
	proof := recoveryFirewallProof{
		ID: controller.id, Operation: "cut", Direction: "both", CorePID: controller.corePID, IdentityVerified: true,
		RuleNames: []string{prefix + "-in", prefix + "-out", prefix + "-proof"}, RequestedMilliseconds: 35000, HeldMilliseconds: 35000,
		ReleaseStartedAt: time.Now().UTC(), ReleasedAt: time.Now().UTC().Add(time.Millisecond), WatchdogDeadline: controller.deadline,
	}
	data, err := json.Marshal(proof)
	must(t, err)
	if _, err := controller.decodeReceipt(data, "cut", "both", 35000); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.decodeReceipt([]byte("{}"), "close", "none", 0); err == nil {
		t.Fatal("empty receipt was admitted as confirmed cleanup")
	}
	for _, field := range []string{"activeRules", "id", "operation", "identityVerified", "cleanupConfirmed", "releaseStartedAt"} {
		var object map[string]any
		must(t, json.Unmarshal(data, &object))
		delete(object, field)
		encoded, err := json.Marshal(object)
		must(t, err)
		if _, err := controller.decodeReceipt(encoded, "cut", "both", 35000); err == nil {
			t.Fatalf("missing receipt field admitted: %s", field)
		}
	}
	for _, alter := range []func(*recoveryFirewallProof){
		func(p *recoveryFirewallProof) { p.ID = "other" },
		func(p *recoveryFirewallProof) { p.CorePID++ },
		func(p *recoveryFirewallProof) { p.Operation = "close" },
		func(p *recoveryFirewallProof) { p.Direction = "inbound" },
		func(p *recoveryFirewallProof) { p.HeldMilliseconds = 34999 },
		func(p *recoveryFirewallProof) { p.IdentityVerified = false },
		func(p *recoveryFirewallProof) { p.RuleNames = []string{"unowned"} },
		func(p *recoveryFirewallProof) { p.WatchdogDeadline = p.WatchdogDeadline.Add(time.Second) },
	} {
		changed := proof
		alter(&changed)
		encoded, err := json.Marshal(changed)
		must(t, err)
		if _, err := controller.decodeReceipt(encoded, "cut", "both", 35000); err == nil {
			t.Fatal("foreign, stale or incomplete fault receipt admitted")
		}
	}
}

func TestWorkbenchRecoveryFirewallPreservesSeparateFailureAndCleanup(t *testing.T) {
	controller := &recoveryFirewall{id: strings.Repeat("b", 32), corePID: 1234, deadline: time.Now().UTC()}
	prefix := "DSHKer-UDPFault-" + controller.id
	proof := recoveryFirewallProof{
		ID: controller.id, CorePID: controller.corePID, Operation: "cut", Direction: "inbound", RequestedMilliseconds: 3000,
		RuleNames: []string{prefix + "-in", prefix + "-out", prefix + "-proof"}, WatchdogDeadline: controller.deadline,
		ErrorCode: "first-operation-failure", CleanupError: "secondary-cleanup-failure", ActiveRules: -1,
	}
	encoded, err := json.Marshal(proof)
	must(t, err)
	read, err := controller.decodeReceipt(encoded, "cut", "inbound", 3000)
	if err != nil || read.ErrorCode != proof.ErrorCode || read.CleanupError != proof.CleanupError || read.ActiveRules != -1 {
		t.Fatal("cleanup replaced the operation's first failure")
	}
}

func TestWorkbenchRecoveryFirewallScopeAndArgumentAdmission(t *testing.T) {
	root := t.TempDir()
	valid := filepath.Join(root, "dshker-recovery-cross-12345678-1234-1234-1234-123456789012", "dshkerd.exe")
	if err := recoveryFirewallScope(valid, root, 1234, 5678); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{filepath.Join(root, "dshkerd.exe"), filepath.Join(root, "Programs", "DSHKer Launcher", "dshkerd.exe"), strings.ReplaceAll(valid, "dshkerd.exe", "node.exe"), valid + "\n"} {
		if recoveryFirewallScope(invalid, root, 1234, 5678) == nil {
			t.Fatalf("unowned executable admitted: %q", invalid)
		}
	}
	args := recoveryFirewallArguments("C:\\Temp\\a'b\\controller.ps1", "C:\\Temp\\a'b\\plan.json", "cut", "outbound", 3000)
	if len(args) != 4 || args[0] != "-NoProfile" || args[2] != "-EncodedCommand" {
		t.Fatal("unexpected PowerShell admission surface")
	}
	data, err := base64.StdEncoding.DecodeString(args[3])
	must(t, err)
	var units []uint16
	for offset := 0; offset < len(data); offset += 2 {
		units = append(units, binary.LittleEndian.Uint16(data[offset:]))
	}
	source := string(utf16.Decode(units))
	if !strings.Contains(source, "a''b") || !strings.Contains(source, "-Direction 'outbound' -Milliseconds 3000") || strings.Contains(source, "ExecutionPolicy") {
		t.Fatal("PowerShell command lost exact quoting or changed system policy")
	}
}
