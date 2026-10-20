//go:build live && windows

package integration

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func recoveryPauseHoldReceiptDeleteAccess(t *testing.T, path string) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	must(t, err)
	handle, err := windows.CreateFile(name, windows.DELETE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	must(t, err)
	t.Cleanup(func() { must(t, windows.CloseHandle(handle)) })
}

// Only t.TempDir files/handles are used. No core, process suspension, account,
// credential, installed application or Windows setting is accessed.
func TestWorkbenchRecoveryPauseReceiptReaderAdmitsDeleteAccessOnFirstOpen(t *testing.T) {
	root := t.TempDir()
	plan, proof, now := recoveryPausePurePlan()
	path := filepath.Join(root, "paused.json")
	must(t, recoveryPauseWrite(root, "paused.json", proof))
	recoveryPauseHoldReceiptDeleteAccess(t, path)
	// Exact old implementation, once: its share mask omits FILE_SHARE_DELETE.
	if _, err := os.ReadFile(path); !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Fatal("old receipt reader did not expose the actual DELETE-access sharing conflict", err)
	}
	var actual recoveryPauseProof
	must(t, recoveryPauseRead(root, "paused.json", &actual)) // One new first open.
	if actual != proof {
		t.Fatal("shared first open did not read the exact immutable receipt", actual)
	}
	must(t, (&recoveryPauseReceiptLedger{}).accept(plan, actual, now))
	t.Log("receipt-sharing oldOpen=ERROR_SHARING_VIOLATION newOpen=success exactReceipt=true deleteAccessHeld=true attempts=1 strictLedger=true")
}

func TestWorkbenchRecoveryPauseReceiptReaderKeepsStrictInvalidAdmission(t *testing.T) {
	for _, name := range []string{"invalid-json", "unknown", "missing", "null", "duplicate", "trailing", "foreign-nonce", "timing"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			plan, proof, now := recoveryPausePurePlan()
			data, err := json.Marshal(proof)
			must(t, err)
			want := "test.pause_receipt_invalid"
			switch name {
			case "invalid-json":
				data = []byte(`{`)
			case "unknown":
				data = []byte(strings.TrimSuffix(string(data), "}") + `,"unknown":true}`)
			case "missing", "null":
				var fields map[string]json.RawMessage
				must(t, json.Unmarshal(data, &fields))
				if name == "missing" {
					delete(fields, "id")
				} else {
					fields["id"] = json.RawMessage(`null`)
				}
				data, err = json.Marshal(fields)
				must(t, err)
				want = "test.pause_receipt_missing_field"
			case "duplicate":
				data = []byte(`{"id":"` + proof.ID + `",` + strings.TrimPrefix(string(data), "{"))
				want = "test.pause_receipt_duplicate_or_trailing"
			case "trailing":
				data = append(data, []byte(` {}`)...)
				want = "test.pause_receipt_trailing_data"
			case "foreign-nonce":
				proof.ID = strings.Repeat("c", 32)
				data, err = json.Marshal(proof)
				must(t, err)
				want = "test.pause_receipt_scope_or_deadline"
			case "timing":
				proof.ReleaseStartedAt = proof.PausedAt
				data, err = json.Marshal(proof)
				must(t, err)
				want = "test.pause_receipt_timing_invalid"
			}
			path := filepath.Join(root, "paused.json")
			must(t, os.WriteFile(path, data, 0o600))
			recoveryPauseHoldReceiptDeleteAccess(t, path)
			var actual recoveryPauseProof
			err = recoveryPauseRead(root, "paused.json", &actual)
			if name == "foreign-nonce" || name == "timing" {
				must(t, err)
				err = (&recoveryPauseReceiptLedger{}).accept(plan, actual, now)
			}
			if err == nil || err.Error() != want {
				t.Fatal("shared receipt reader weakened strict schema/nonce/timing admission", err, want)
			}
		})
	}
}

func TestWorkbenchRecoveryPauseReceiptReaderPreservesNativeOpenFailure(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "paused.json")
	_, proof, _ := recoveryPausePurePlan()
	must(t, recoveryPauseWrite(root, "paused.json", proof))
	name, err := windows.UTF16PtrFromString(path)
	must(t, err)
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	must(t, err)
	t.Cleanup(func() { must(t, windows.CloseHandle(handle)) })
	var actual recoveryPauseProof
	err = recoveryPauseRead(root, "paused.json", &actual)
	var native *os.PathError
	if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) || !errors.As(err, &native) || native.Op != "open" || native.Path != path || !actual.PausedAt.IsZero() {
		t.Fatal("incompatible open was retried, hidden or converted into a receipt", err, actual)
	}
	t.Log("receipt-sharing incompatibleShare=ERROR_SHARING_VIOLATION attempts=1 originalPathError=true")
}
