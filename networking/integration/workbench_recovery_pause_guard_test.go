//go:build live

package integration

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"
)

type recoveryPauseDebuggerObservation struct {
	Succeeded       bool   `json:"succeeded"`
	DebuggerPresent bool   `json:"debuggerPresent"`
	Win32Error      uint32 `json:"win32Error"`
}

type recoveryPauseDebugAPIError struct{ Win32Error uint32 }

func (err *recoveryPauseDebugAPIError) Error() string {
	return fmt.Sprintf("test.pause_debug_state_unavailable: win32=%d", err.Win32Error)
}

func (err *recoveryPauseDebugAPIError) Unwrap() error { return syscall.Errno(err.Win32Error) }

func recoveryPauseDebuggerResult(value uintptr, present, errno uint32) (recoveryPauseDebuggerObservation, error) {
	if value == 0 {
		return recoveryPauseDebuggerObservation{Win32Error: errno}, &recoveryPauseDebugAPIError{Win32Error: errno}
	}
	// GetLastError is not meaningful after a successful Win32 call.
	return recoveryPauseDebuggerObservation{Succeeded: true, DebuggerPresent: present != 0}, nil
}

// All clocks belong to Windows. ReleaseStartedTickMilliseconds starts the
// existing 25s budget; UTC sanity checks never grant time or extend cleanup.
type recoveryPauseProof struct {
	ID                             string               `json:"id"`
	CorePID                        int                  `json:"corePid"`
	CreationSHA                    recoveryProcessProof `json:"creationSha"`
	IdentityVerified               bool                 `json:"identityVerified"`
	RequestedHeldMilliseconds      int64                `json:"requestedHeldMilliseconds"`
	PausedAt                       time.Time            `json:"pausedAt"`
	PausedTickMilliseconds         uint64               `json:"pausedTickMilliseconds"`
	ReleaseStartedAt               time.Time            `json:"releaseStartedAt"`
	ReleaseStartedTickMilliseconds uint64               `json:"releaseStartedTickMilliseconds"`
	ReleasedAt                     time.Time            `json:"releasedAt"`
	ReleasedTickMilliseconds       uint64               `json:"releasedTickMilliseconds"`
	ControllerPID                  int                  `json:"controllerPid"`
	GuardTerminatedController      bool                 `json:"guardTerminatedController"`
	CleanupConfirmed               bool                 `json:"cleanupConfirmed"`
	Outcome                        string               `json:"outcome"`
	ErrorCode                      string               `json:"errorCode"`
}

type recoveryPauseHoldAction int

type recoveryPauseFailedRelease struct {
	ID            string               `json:"id"`
	Core          recoveryProcessProof `json:"core"`
	ControllerPID int                  `json:"controllerPid"`
	ErrorCode     string               `json:"errorCode"`
}

func (failed recoveryPauseFailedRelease) cause(plan recoveryPausePlan) error {
	if failed.ID != plan.ID || failed.Core != plan.Core || failed.ControllerPID != plan.Controller.PID || failed.ErrorCode == "" {
		return errors.New("test.pause_failed_release_receipt_mismatch")
	}
	return errors.New(failed.ErrorCode)
}

const (
	recoveryPauseHolding recoveryPauseHoldAction = iota
	recoveryPauseRelease
	recoveryPauseGuardTakeover
	recoveryPauseReleaseFailed
)

func recoveryPauseHoldDecision(runnerAlive, guardAlive bool, runnerErr, guardErr error, complete, expired bool) recoveryPauseHoldAction {
	if guardErr != nil || !guardAlive || expired {
		return recoveryPauseReleaseFailed
	}
	if runnerErr != nil || !runnerAlive {
		return recoveryPauseGuardTakeover
	}
	if complete {
		return recoveryPauseRelease
	}
	return recoveryPauseHolding
}

type recoveryPausePlan struct {
	ID                       string               `json:"id"`
	Root                     string               `json:"root"`
	Binary                   string               `json:"binary"`
	TestBinary               string               `json:"testBinary"`
	Core                     recoveryProcessProof `json:"core"`
	Runner                   recoveryProcessProof `json:"runner"`
	Controller               recoveryProcessProof `json:"controller"`
	CreatedAt                time.Time            `json:"createdAt"`
	Deadline                 time.Time            `json:"deadline"`
	CreatedTickMilliseconds  uint64               `json:"createdTickMilliseconds"`
	DeadlineTickMilliseconds uint64               `json:"deadlineTickMilliseconds"`
	HeldMillis               int64                `json:"heldMillis"`
}

type recoveryPauseReady struct {
	ID         string               `json:"id"`
	Core       recoveryProcessProof `json:"core"`
	Controller recoveryProcessProof `json:"controller"`
	Guard      recoveryProcessProof `json:"guard"`
	Deadline   time.Time            `json:"deadline"`
	At         time.Time            `json:"at"`
}

func recoveryPauseScope(binary, temp string, pid, parent int) error {
	if !filepath.IsAbs(binary) || filepath.Clean(binary) != binary || !filepath.IsAbs(temp) || pid <= 0 || parent <= 0 || pid == parent {
		return errors.New("test.pause_explicit_identity_required")
	}
	directory := filepath.Dir(binary)
	if filepath.Base(binary) != "dshkerd.exe" || strings.ContainsAny(binary, "\r\n\x00*?[]") || filepath.Dir(directory) != filepath.Clean(temp) || !strings.HasPrefix(filepath.Base(directory), "dshker-recovery-cross-") {
		return errors.New("test.pause_unowned_executable")
	}
	return nil
}

func recoveryPauseValidIdentity(proof recoveryProcessProof) bool {
	decoded, err := hex.DecodeString(proof.ExecutableSHA256)
	return proof.PID > 0 && proof.ParentPID > 0 && proof.Creation > 0 && err == nil && len(decoded) == 32 && hex.EncodeToString(decoded) == proof.ExecutableSHA256
}

func recoveryPauseRequireSameIdentity(expected, observed recoveryProcessProof) error {
	if !recoveryPauseValidIdentity(expected) || !recoveryPauseValidIdentity(observed) || expected != observed {
		return errors.New("test.pause_held_identity_mismatch")
	}
	return nil
}

func (plan recoveryPausePlan) validate(now time.Time) error {
	nonce, err := hex.DecodeString(plan.ID)
	if err != nil || len(nonce) != 16 || hex.EncodeToString(nonce) != plan.ID || !recoveryPauseValidIdentity(plan.Core) || !recoveryPauseValidIdentity(plan.Runner) || !recoveryPauseValidIdentity(plan.Controller) {
		return errors.New("test.pause_plan_identity_invalid")
	}
	if plan.Core.ParentPID != plan.Runner.PID || plan.Controller.ParentPID != plan.Runner.PID || plan.Core.PID == plan.Controller.PID || plan.Runner.PID == plan.Controller.PID || plan.Core.PID == plan.Runner.PID {
		return errors.New("test.pause_plan_parent_mismatch")
	}
	if err := recoveryPauseScope(plan.Binary, os.TempDir(), plan.Core.PID, plan.Core.ParentPID); err != nil {
		return err
	}
	if !filepath.IsAbs(plan.TestBinary) || filepath.Clean(plan.TestBinary) != plan.TestBinary || filepath.Dir(plan.Root) != filepath.Clean(os.TempDir()) || !strings.HasPrefix(filepath.Base(plan.Root), "dshker-program-pause-") || filepath.Clean(plan.Root) != plan.Root {
		return errors.New("test.pause_plan_root_invalid")
	}
	if plan.HeldMillis != 3000 && plan.HeldMillis != 35000 {
		return errors.New("test.pause_duration_not_authorized")
	}
	if plan.CreatedAt.IsZero() || plan.CreatedAt.After(now) || !plan.Deadline.After(now) || plan.Deadline.Sub(plan.CreatedAt) > time.Duration(plan.HeldMillis)*time.Millisecond+15*time.Second {
		return errors.New("test.pause_guard_deadline_invalid")
	}
	if plan.CreatedTickMilliseconds == 0 || plan.DeadlineTickMilliseconds <= plan.CreatedTickMilliseconds || plan.DeadlineTickMilliseconds-plan.CreatedTickMilliseconds > uint64(plan.HeldMillis)+15000 {
		return errors.New("test.pause_guard_tick_deadline_invalid")
	}
	return nil
}

func (plan recoveryPausePlan) remainingAt(nowTick uint64) (time.Duration, error) {
	if plan.CreatedTickMilliseconds == 0 || nowTick < plan.CreatedTickMilliseconds || plan.DeadlineTickMilliseconds <= nowTick || plan.DeadlineTickMilliseconds-plan.CreatedTickMilliseconds > uint64(plan.HeldMillis)+15000 {
		return 0, errors.New("test.pause_guard_monotonic_deadline_expired_or_invalid")
	}
	return time.Duration(plan.DeadlineTickMilliseconds-nowTick) * time.Millisecond, nil
}

func recoveryPauseDecode(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("test.pause_receipt_invalid")
	}
	var extra json.RawMessage
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("test.pause_receipt_trailing_data")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return errors.New("test.pause_receipt_object_required")
	}
	target := reflect.TypeOf(value)
	if target.Kind() != reflect.Pointer || target.Elem().Kind() != reflect.Struct {
		return errors.New("test.pause_receipt_struct_required")
	}
	for _, field := range reflect.VisibleFields(target.Elem()) {
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if raw, exists := fields[name]; !exists || bytes.Equal(raw, []byte("null")) {
			return errors.New("test.pause_receipt_missing_field")
		}
	}
	// Disallow duplicates as well as missing fields: decoding into a struct alone
	// accepts duplicate keys. These receipts have no nested arbitrary objects.
	var seen func(*json.Decoder) error
	seen = func(decoder *json.Decoder) error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		if token != json.Delim('{') {
			return errors.New("test.pause_receipt_object_required")
		}
		keys := map[string]bool{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil || keys[key.(string)] {
				return errors.New("test.pause_receipt_duplicate_field")
			}
			keys[key.(string)] = true
			var raw json.RawMessage
			if err := decoder.Decode(&raw); err != nil {
				return err
			}
			if len(raw) > 0 && raw[0] == '{' {
				if err := seen(json.NewDecoder(bytes.NewReader(raw))); err != nil {
					return err
				}
			}
		}
		_, err = decoder.Token()
		return err
	}
	strict := json.NewDecoder(bytes.NewReader(data))
	if err := seen(strict); err != nil || strict.More() {
		return errors.New("test.pause_receipt_duplicate_or_trailing")
	}
	return nil
}

func recoveryPauseVersion(data []byte) error {
	var decoded struct {
		Version            int      `json:"version"`
		MethodTableVersion int      `json:"methodTableVersion"`
		Methods            []string `json:"methods"`
	}
	if recoveryPauseDecode(data, &decoded) != nil || decoded.Version != 1 || decoded.MethodTableVersion != 2 || len(decoded.Methods) == 0 {
		return errors.New("test.pause_authenticated_rpc_version_missing")
	}
	for _, method := range decoded.Methods {
		if method == "core.version" {
			return nil
		}
	}
	return errors.New("test.pause_authenticated_rpc_version_missing")
}

func recoveryPauseWrite(root, name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	// Receipts are immutable and unique per nonce. The random sibling is only
	// ever renamed into an absent destination; no old run can be overwritten.
	if _, err := os.Lstat(filepath.Join(root, name)); !os.IsNotExist(err) {
		return errors.New("test.pause_receipt_already_exists")
	}
	file, err := os.CreateTemp(root, ".receipt-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	_, writeErr := file.Write(data)
	syncErr, closeErr := file.Sync(), file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(root, name))
}

func recoveryPauseRead(root, name string, value any) error {
	data, err := recoveryPauseReadBytes(filepath.Join(root, name))
	if err != nil {
		return err
	}
	return recoveryPauseDecode(data, value)
}

func (plan recoveryPausePlan) acceptReady(ready recoveryPauseReady, now time.Time) error {
	if ready.ID != plan.ID || ready.Core != plan.Core || ready.Controller != plan.Controller || !recoveryPauseValidIdentity(ready.Guard) || ready.Guard.ParentPID != plan.Runner.PID || ready.Guard.PID == plan.Controller.PID || ready.Guard.PID == plan.Core.PID || ready.Deadline != plan.Deadline || ready.At.Before(plan.CreatedAt) || ready.At.After(now) || !now.Before(plan.Deadline) {
		return errors.New("test.pause_guard_ready_mismatch")
	}
	return nil
}

// Each ledger belongs to one nonce. A duplicate final receipt is not a new
// successful pause, and late buffered success cannot cross the hard deadline.
type recoveryPauseReceiptLedger struct{ consumed bool }

func (ledger *recoveryPauseReceiptLedger) accept(plan recoveryPausePlan, proof recoveryPauseProof, now time.Time) error {
	if ledger.consumed || !now.Before(plan.Deadline) || proof.ID != plan.ID || proof.CorePID != plan.Core.PID || proof.CreationSHA != plan.Core || proof.ControllerPID != plan.Controller.PID || !proof.IdentityVerified || proof.RequestedHeldMilliseconds != plan.HeldMillis || proof.ReleaseStartedTickMilliseconds == 0 {
		return errors.New("test.pause_receipt_scope_or_deadline")
	}
	if proof.PausedAt.Before(plan.CreatedAt) || proof.ReleaseStartedAt.Before(proof.PausedAt.Add(time.Duration(plan.HeldMillis)*time.Millisecond)) || proof.ReleasedAt.Before(proof.ReleaseStartedAt) || proof.ReleasedAt.After(now) || proof.ReleasedAt.After(plan.Deadline) {
		return errors.New("test.pause_receipt_timing_invalid")
	}
	if proof.PausedTickMilliseconds < plan.CreatedTickMilliseconds || proof.ReleaseStartedTickMilliseconds < proof.PausedTickMilliseconds || proof.ReleaseStartedTickMilliseconds-proof.PausedTickMilliseconds < uint64(plan.HeldMillis) || proof.ReleasedTickMilliseconds < proof.ReleaseStartedTickMilliseconds || proof.ReleasedTickMilliseconds >= plan.DeadlineTickMilliseconds {
		return errors.New("test.pause_receipt_monotonic_timing_invalid")
	}
	ledger.consumed = true
	if !proof.CleanupConfirmed || proof.Outcome != "resumed" || proof.ErrorCode != "" || proof.GuardTerminatedController {
		return errors.New("test.pause_cleanup_failed")
	}
	return nil
}
