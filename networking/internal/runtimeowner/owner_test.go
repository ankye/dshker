package runtimeowner

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/localrpc"
)

// A real separate test process uses the same Run entry as the production
// private mode. No account, secret provider, or networking core is constructed.
func TestMain(tests *testing.M) {
	if runContainmentTestChild(os.Args[1:]) {
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == "--runtime-owner" {
		flags := flag.NewFlagSet("runtime-owner-test", flag.ContinueOnError)
		var config Config
		flags.StringVar(&config.StateRoot, "state", "", "")
		flags.StringVar(&config.DataRoot, "data", "", "")
		flags.StringVar(&config.CatalogRoot, "catalog", "", "")
		flags.StringVar(&config.RootsPath, "roots", "", "")
		if flags.Parse(os.Args[2:]) != nil {
			os.Exit(2)
		}
		config.Executable, _ = os.Executable()
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := Run(ctx, config); err != nil {
			os.Stderr.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		os.Exit(0)
	}
	os.Exit(tests.Run())
}

func ownerTestConfig(t *testing.T) Config {
	t.Helper()
	state, err := os.MkdirTemp("", "dshker-runtime-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			logFailedOwner(t, state)
			return // Preserve this exact isolated failure, including its owner log.
		}
		os.RemoveAll(state)
	})
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Config{StateRoot: state, Executable: executable}
}

func logFailedOwner(t *testing.T, state string) {
	t.Helper()
	directory := filepath.Join(state, ownerDirectory)
	t.Logf("retained isolated owner failure directory=%s", directory)
	record, err := readRecord(filepath.Join(directory, recordFileName))
	if err == nil {
		stage := "pending"
		if record.Process.PID != 0 {
			stage = "published"
		}
		t.Logf("owner failure identity stage=%s", stage)
	} else {
		t.Log("owner failure identity stage=unreadable")
	}
	file, err := os.Open(filepath.Join(directory, "owner.log"))
	if err != nil {
		t.Log("owner failure terminal log=unavailable")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		t.Log("owner failure terminal log=unreadable")
		return
	}
	if len(data) > 4096 {
		data = data[:4096]
		t.Log("owner failure terminal log=truncated")
	}
	allowed := map[string]bool{}
	for _, code := range []error{ErrOwnerUnavailable, ErrOwnerIdentityMismatch, ErrOwnerRecordInvalid, ErrOwnerProtocol, ErrOwnerConfiguration, ErrOwnerShutdown} {
		allowed[code.Error()] = true
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		line = strings.TrimSpace(line)
		if allowed[line] {
			t.Logf("owner failure terminal code=%s", line)
		} else if fields := strings.Fields(line); len(fields) == 4 && (fields[0] == ErrOwnerRecordInvalid.Error()+":" || fields[0] == ErrOwnerProtocol.Error()+":") && fields[1] == "record" {
			stages := map[string]bool{"encode": true, "open-temp": true, "secure-acl": true, "write": true, "sync": true, "close": true, "rename": true, "directory-sync": true, "acl-descriptor": true, "acl-set": true, "acl-read": true}
			errno, present := strings.CutPrefix(fields[3], "errno=")
			_, parseErr := strconv.ParseUint(errno, 10, 32)
			if stages[fields[2]] && present && (errno == "unknown" || parseErr == nil) {
				t.Logf("owner failure terminal code=%s stage=%s errno=%s", strings.TrimSuffix(fields[0], ":"), fields[2], errno)
			} else {
				t.Log("owner failure terminal line=redacted")
			}
		} else if line != "" {
			t.Log("owner failure terminal line=redacted")
		}
	}
}

func childRequest(t *testing.T, state string, subject string) harnessruntime.LaunchRequest {
	t.Helper()
	script := filepath.Join(state, "owned-child.sh")
	executable := "/bin/sh"
	prefix := []string{script}
	source := "#!/bin/sh\necho 'dsh web: http://127.0.0.1:3088/?token=unit-owned-child'\nwhile :; do echo owned-stdout; echo owned-stderr >&2; sleep 0.03; done\n"
	if runtime.GOOS == "windows" {
		executable = os.Getenv("ComSpec")
		if executable == "" {
			t.Fatal("explicit Windows ComSpec is unavailable")
		}
		script = filepath.Join(state, "owned-child.cmd")
		prefix = []string{"/c", script}
		source = "@echo off\r\necho dsh web: http://127.0.0.1:3088/?token=unit-owned-child\r\n:again\r\necho owned-stdout\r\necho owned-stderr 1>&2\r\nping -n 2 127.0.0.1 >nul\r\ngoto again\r\n"
	}
	if err := os.WriteFile(script, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	return harnessruntime.LaunchRequest{LaunchID: "launch_" + subject, SubjectID: subject, Directory: state, Profile: harnessruntime.ProfilePnpm, PnpmExecutable: executable, PnpmPrefixArguments: prefix, DiagnosticsPatchPath: filepath.Join(state, "overlay.yml"), Port: harnessruntime.AutoPort(), LogPath: filepath.Join(state, "child.log")}
}

func waitOwner(t *testing.T, message string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal(message)
		}
		time.Sleep(time.Millisecond)
	}
}

func shutdownOwner(t *testing.T, client *Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.Shutdown(ctx); err != nil {
		t.Errorf("owner shutdown did not join its exact process: %v", err)
	}
}

func TestOwnerReconnectKeepsRealChildBindingAndOutput(t *testing.T) {
	config := ownerTestConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	first, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	currentClient := first
	t.Cleanup(func() { shutdownOwner(t, currentClient) })
	if !first.Created() {
		t.Fatal("fresh explicit root did not create its first empty owner")
	}
	request := childRequest(t, config.StateRoot, "subject_main")
	started, err := first.Start(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	var initial harnessruntime.LaunchView
	waitOwner(t, "real owned child never announced readiness", func() bool {
		view, present, err := first.Status(ctx, request.SubjectID)
		initial = view
		return err == nil && present && view.State == harnessruntime.StateRunning
	})
	binding, err := first.Binding(ctx, request.SubjectID)
	if err != nil {
		t.Fatal(err)
	}
	_, cursor, err := first.Console(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	identity := first.Identity()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	currentClient = second
	if second.Created() || second.Identity() != identity {
		t.Fatal("core reconnect replaced the existing authenticated owner")
	}
	current, present, err := second.Status(ctx, request.SubjectID)
	if err != nil || !present || current.PID != started.PID || current.LaunchID != initial.LaunchID || current.StartedAtUnix != initial.StartedAtUnix || current.Directory != initial.Directory {
		t.Fatal("core reconnect did not retain exact original child identity")
	}
	rebound, err := second.Binding(ctx, request.SubjectID)
	if err != nil || rebound != binding {
		t.Fatal("core reconnect changed the original live binding generation or URL")
	}
	waitOwner(t, "stdout/stderr stopped draining after the original core client disappeared", func() bool {
		entries, next, err := second.Console(ctx, cursor)
		stdout, stderr := false, false
		for _, entry := range entries {
			stdout = stdout || strings.Contains(entry.Text, "owned-stdout")
			stderr = stderr || strings.Contains(entry.Text, "owned-stderr")
		}
		return err == nil && next > cursor && stdout && stderr
	})
	if _, err := second.Stop(ctx, request.SubjectID); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := second.Binding(ctx, request.SubjectID); !errors.Is(err, ErrRuntimeUnavailable) {
			t.Fatalf("stopped runtime was rebound or started: %v", err)
		}
	}
	if harnessruntime.ProcessAlive(started.PID) {
		t.Fatal("explicit stop returned before the original child exited")
	}
}

func TestLocalStartRefusesLiveSubjectBeforePortAction(t *testing.T) {
	config := ownerTestConfig(t)
	local := NewLocal()
	t.Cleanup(func() {
		if err := local.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	request := childRequest(t, config.StateRoot, "subject_port")
	started, err := local.Start(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	request.Port, err = harnessruntime.FixedPort(listener.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.Start(context.Background(), request); !errors.Is(err, harnessruntime.ErrOperationInProgress) {
		t.Fatalf("duplicate subject reached fixed-port preparation: %v", err)
	}
	if !harnessruntime.ProcessAlive(started.PID) {
		t.Fatal("duplicate start killed the current owned child")
	}
	request.SubjectID = "subject_other"
	request.LaunchID = "launch_other"
	if _, err := local.Start(context.Background(), request); !errors.Is(err, harnessruntime.ErrPortInUse) {
		t.Fatalf("occupied foreign port was not explicitly refused: %v", err)
	}
}

func TestOwnerPrivateRequestsRejectUnknownAndMalformedFields(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, b := net.Pipe()
	defer b.Close()
	peer := localrpc.New(ctx, a, func(context.Context, string, json.RawMessage) (any, error) { return nil, nil })
	defer peer.Close()
	server := &ownerServer{local: NewLocal(), stop: cancel}
	handler := server.handlerFor(peer)
	for method, payload := range map[string]string{"owner.hello": `{"extra":true}`, "owner.start": `{}`, "owner.stop": `{"subjectId":"x","extra":true}`, "owner.status": `{}`, "owner.binding": `{"subjectId":""}`, "owner.console": `{"cursor":-1}`, "owner.shutdown": `{"extra":true}`, "owner.unsupported": `{}`} {
		if _, err := handler(ctx, method, json.RawMessage(payload)); err == nil {
			t.Fatalf("private owner admitted malformed/unknown request %s", method)
		}
	}
}

func TestLocalStartRefusesOccupiedLoopbackFamilies(t *testing.T) {
	for _, family := range []struct{ network, address string }{{"tcp4", "127.0.0.1:0"}, {"tcp6", "[::1]:0"}} {
		t.Run(family.network, func(t *testing.T) {
			config := ownerTestConfig(t)
			local := NewLocal()
			t.Cleanup(func() {
				if err := local.Shutdown(context.Background()); err != nil {
					t.Error(err)
				}
			})
			listener, err := net.Listen(family.network, family.address)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			request := childRequest(t, config.StateRoot, "subject_occupied")
			request.Port, err = harnessruntime.FixedPort(listener.Addr().(*net.TCPAddr).Port)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := local.Start(context.Background(), request); !errors.Is(err, harnessruntime.ErrPortInUse) {
				t.Fatalf("occupied %s loopback port was not refused: %v", family.network, err)
			}
			if _, present, err := local.Status(context.Background(), request.SubjectID); err != nil || present {
				t.Fatal("occupied port refusal spawned or registered a child")
			}
			connection, err := net.DialTimeout(family.network, listener.Addr().String(), time.Second)
			if err != nil {
				t.Fatalf("fixed-port admission disturbed the foreign listener: %v", err)
			}
			connection.Close()
		})
	}
}
