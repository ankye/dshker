package secret

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

// fakeExit is a process failure with an exit status and no process behind it.
type fakeExit struct{ code int }

func (failure fakeExit) Error() string { return "exit status " + string(rune('0'+failure.code)) }
func (failure fakeExit) ExitCode() int { return failure.code }

// recorder is the tool: it records what it was asked and answers with what a
// real secret-tool would have printed.
type recorder struct {
	calls  [][]string
	stdin  []string
	stdout string
	stderr string
	err    error
}

func (tool *recorder) run(stdin string, arguments ...string) (string, string, error) {
	tool.calls = append(tool.calls, arguments)
	tool.stdin = append(tool.stdin, stdin)
	return tool.stdout, tool.stderr, tool.err
}

func (tool *recorder) store() secretServiceStore { return secretServiceStore{run: tool.run} }

// TestSecretServiceArgumentsAreTheContract pins the invocation: the attributes
// are the item's identity and secret-tool takes them in pairs, the label is what
// a keyring browser shows, and a write carries the value on stdin rather than in
// argv where any process listing could read it.
func TestSecretServiceArgumentsAreTheContract(t *testing.T) {
	tool := &recorder{}
	if err := tool.store().Set("device.p12", []byte{0x00, 0xff, 0x10}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if len(tool.calls) != 1 {
		t.Fatalf("calls = %v", tool.calls)
	}
	want := []string{
		"store",
		"--label",
		"dshkerd device.p12",
		"service",
		"dshkerd",
		"key",
		"device.p12",
	}
	if strings.Join(tool.calls[0], " ") != strings.Join(want, " ") {
		t.Fatalf("store arguments = %v", tool.calls[0])
	}
	if tool.stdin[0] != base64.StdEncoding.EncodeToString([]byte{0x00, 0xff, 0x10}) {
		t.Fatalf("stdin = %q", tool.stdin[0])
	}
	if strings.Contains(strings.Join(tool.calls[0], " "), tool.stdin[0]) {
		t.Fatal("the value reached argv")
	}

	tool = &recorder{}
	if _, err := tool.store().Get("device.p12"); err != nil {
		t.Fatalf("get: %v", err)
	}
	want = []string{"lookup", "service", "dshkerd", "key", "device.p12"}
	if strings.Join(tool.calls[0], " ") != strings.Join(want, " ") {
		t.Fatalf("lookup arguments = %v", tool.calls[0])
	}
	if tool.stdin[0] != "" {
		t.Fatalf("lookup stdin = %q", tool.stdin[0])
	}
}

// TestSecretServiceRoundTripsBinaryValues covers what the text channel would
// otherwise destroy, and tolerates the trailing newline the tool adds.
func TestSecretServiceRoundTripsBinaryValues(t *testing.T) {
	value := []byte{0x00, 0x01, 0xfe, 0xff, '\n', 0x7f}
	tool := &recorder{stdout: base64.StdEncoding.EncodeToString(value) + "\n"}
	read, err := tool.store().Get("device.p12")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(read) != string(value) {
		t.Fatalf("value = %v", read)
	}
}

// TestSecretServiceClassifiesFailures is the part a headless Linux box depends
// on: no keyring at all must be reported as a missing provider, not as a
// damaged item, and an absent item must be reported as missing rather than as a
// read failure.
func TestSecretServiceClassifiesFailures(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		stderr string
		err    error
		want   error
	}{
		{name: "no such item", stderr: "", err: fakeExit{1}, want: ErrMissing},
		{name: "no session bus", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY", err: fakeExit{1}, want: ErrUnavailable},
		{name: "unreachable socket", stderr: "Failed to open connection: No such file or directory", err: fakeExit{1}, want: ErrUnavailable},
		{name: "garbage output", stdout: "not base64!", want: ErrRead},
		{name: "other failure", stderr: "some other problem", err: fakeExit{2}, want: ErrRead},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			tool := &recorder{stdout: testCase.stdout, stderr: testCase.stderr, err: testCase.err}
			if _, err := tool.store().Get("device.p12"); !errors.Is(err, testCase.want) {
				t.Fatalf("get = %v, want %v", err, testCase.want)
			}
		})
	}
}

// TestSecretServiceWriteAndDeleteFailures keeps the two mutating operations'
// codes distinct: a keyring that cannot be reached is unavailable for a write
// too, an absent item is a successful delete, and any other delete failure keeps
// its own code.
func TestSecretServiceWriteAndDeleteFailures(t *testing.T) {
	unreachable := &recorder{stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY", err: fakeExit{1}}
	if err := unreachable.store().Set("device.p12", []byte("x")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("set without a keyring = %v", err)
	}

	refused := &recorder{stderr: "the collection is locked", err: fakeExit{2}}
	err := refused.store().Set("device.p12", []byte("x"))
	if !errors.Is(err, ErrWrite) || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("locked set = %v", err)
	}

	absent := &recorder{err: fakeExit{1}}
	if err := absent.store().Delete("device.p12"); err != nil {
		t.Fatalf("deleting an absent item = %v", err)
	}
	broken := &recorder{stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY", err: fakeExit{1}}
	if err := broken.store().Delete("device.p12"); !errors.Is(err, ErrDelete) {
		t.Fatalf("delete without a keyring = %v", err)
	}
}
