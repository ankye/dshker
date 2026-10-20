package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/peerbroker"
	"github.com/ankye/dshker/networking/internal/remoteroute"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

type authorityCall struct {
	ctx             context.Context
	method, subject string
	request         harnessruntime.LaunchRequest
	cursor          int64
}

// This test-only authority records the exact boundary. It cannot spawn or stop
// a child and is never reachable from the production composition.
type authorityProbe struct {
	calls   chan authorityCall
	err     error
	view    harnessruntime.LaunchView
	present bool
	binding runtimebridge.Binding
}

func (owner *authorityProbe) Start(ctx context.Context, request harnessruntime.LaunchRequest) (harnessruntime.LaunchView, error) {
	owner.calls <- authorityCall{ctx: ctx, method: "start", subject: request.SubjectID, request: request}
	return owner.view, owner.err
}
func (owner *authorityProbe) Stop(ctx context.Context, subject string) (harnessruntime.LaunchView, error) {
	owner.calls <- authorityCall{ctx: ctx, method: "stop", subject: subject}
	return owner.view, owner.err
}
func (owner *authorityProbe) Status(ctx context.Context, subject string) (harnessruntime.LaunchView, bool, error) {
	owner.calls <- authorityCall{ctx: ctx, method: "status", subject: subject}
	return owner.view, owner.present, owner.err
}
func (owner *authorityProbe) Console(ctx context.Context, cursor int64) ([]harnessruntime.ConsoleEntry, int64, error) {
	owner.calls <- authorityCall{ctx: ctx, method: "console", cursor: cursor}
	return []harnessruntime.ConsoleEntry{}, cursor, owner.err
}
func (owner *authorityProbe) Binding(ctx context.Context, subject string) (runtimebridge.Binding, error) {
	owner.calls <- authorityCall{ctx: ctx, method: "binding", subject: subject}
	return owner.binding, owner.err
}

var _ harnessruntime.Authority = (*authorityProbe)(nil)

func TestRuntimeAuthorityDisconnectPreservesErrorsAndContext(t *testing.T) {
	base := t.TempDir()
	for method, payload := range map[string]json.RawMessage{
		"runtime.start":        startPayload(t, base, "not-executed", []string{}, `{"mode":"auto"}`),
		"runtime.stop":         json.RawMessage(`{"subjectId":"subject_main"}`),
		"runtime.status":       json.RawMessage(`{"subjectId":"subject_main"}`),
		"runtime.console":      json.RawMessage(`{"cursor":17}`),
		"core.runtime_binding": json.RawMessage(`{}`),
	} {
		t.Run(method, func(t *testing.T) {
			owner := &authorityProbe{calls: make(chan authorityCall, 1), err: runtimeowner.ErrOwnerUnavailable}
			server := Serve{Runtime: owner, RuntimeBinding: &RuntimeBinding{Runtime: owner, Subject: "subject_main"}}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			answer, err := server.Handle(ctx, method, payload)
			if !errors.Is(err, runtimeowner.ErrOwnerUnavailable) || answer != nil {
				t.Fatal("owner disconnect was hidden as an empty runtime or success")
			}
			call := <-owner.calls
			if call.ctx != ctx {
				t.Fatal("runtime handler replaced the caller context")
			}
			if method == "runtime.console" {
				if call.cursor != 17 {
					t.Fatal("console lost its exact caller cursor")
				}
			} else if call.subject != "subject_main" {
				t.Fatal("runtime handler changed its exact subject")
			}
			if method == "runtime.start" && (call.request.LaunchID != "launch_main" || call.request.Directory != base || call.request.PnpmExecutable != "not-executed") {
				t.Fatal("runtime handler changed admitted launch identity or executable")
			}
			if len(owner.calls) != 0 {
				t.Fatal("owner refusal triggered another operation or cold start")
			}
		})
	}
}

func TestRuntimeStartDoesNotPrepareOrTerminateAnOccupiedPort(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	owner := &authorityProbe{calls: make(chan authorityCall, 1), err: runtimeowner.ErrOwnerUnavailable}
	server := Serve{Runtime: owner}
	payload := startPayload(t, t.TempDir(), "not-executed", []string{}, fmt.Sprintf(`{"mode":"fixed","port":%d}`, port))
	if _, err := server.Handle(context.Background(), "runtime.start", payload); !errors.Is(err, runtimeowner.ErrOwnerUnavailable) {
		t.Fatal("core inspected or prepared the port before owner-atomic Start admission")
	}
	call := <-owner.calls
	if call.method != "start" || call.request.Port.Port != port {
		t.Fatal("fixed port did not reach the sole runtime authority")
	}
	connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal("core altered a pre-existing port occupant")
	}
	connection.Close()
}

func TestRuntimeBrokerRoutePropagatesAuthorityRefusalWithoutStart(t *testing.T) {
	owner := &authorityProbe{calls: make(chan authorityCall, 1), err: runtimeowner.ErrOwnerUnavailable}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	route := (Serve{Runtime: owner}).runtimeRoute("subject_main")
	if url, err := route(ctx); url != "" || !errors.Is(err, runtimeowner.ErrOwnerUnavailable) {
		t.Fatal("broker route replaced the owner failure with stale runtime state")
	}
	call := <-owner.calls
	if call.method != "status" || call.ctx != ctx || call.subject != "subject_main" || len(owner.calls) != 0 {
		t.Fatal("broker route changed cancellation/scope or invoked runtime Start")
	}
}

func TestRuntimeBrokerRejectsUnavailableAuthorityOverRealHTTP(t *testing.T) {
	owner := &authorityProbe{calls: make(chan authorityCall, 1), err: runtimeowner.ErrOwnerUnavailable}
	holder := &peerbroker.Holder{}
	defer holder.Shutdown()
	server := Serve{Runtime: owner, Brokers: holder}
	file := filepath.Join(t.TempDir(), "broker.json")
	payload, err := json.Marshal(map[string]string{"descriptorPath": file, "subjectId": "subject_main"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.Handle(context.Background(), "remote.broker_start", payload); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor remoteroute.Descriptor
	if err := json.Unmarshal(data, &descriptor); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/runtime/connect", descriptor.Port), nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+descriptor.Secret)
	response, err := (&http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil {
		t.Fatal(err)
	}
	var refusal struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &refusal) != nil || response.StatusCode != http.StatusServiceUnavailable || refusal.Error != "runtime_unavailable" {
		t.Fatal("public broker published an unavailable owner's runtime")
	}
	call := <-owner.calls
	if call.method != "status" || call.subject != "subject_main" || len(owner.calls) != 0 {
		t.Fatal("broker refusal invoked runtime Start or changed subject")
	}
}

func TestRuntimeLocalAuthoritySurvivesCoreFacadeReplacementAndStop(t *testing.T) {
	base := t.TempDir()
	executable, prefix := fakeLauncher(t, base)
	owner := runtimeowner.NewLocalWithSupervisor(harnessruntime.NewSupervisor())
	t.Cleanup(func() {
		if err := owner.Shutdown(context.Background()); err != nil {
			t.Errorf("owned local runtime cleanup: %v", err)
		}
	})
	first := Serve{Runtime: owner, RuntimeBinding: &RuntimeBinding{Runtime: owner, Subject: "subject_main"}}
	if _, err := first.Handle(context.Background(), "runtime.start", startPayload(t, base, executable, prefix, `{"mode":"auto"}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	var original runtimebridge.Binding
	for {
		binding, err := first.RuntimeBinding.Binding()
		if err == nil {
			original = binding
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("explicit local supervisor never reached running")
		}
		time.Sleep(10 * time.Millisecond)
	}
	second := Serve{Runtime: owner, RuntimeBinding: &RuntimeBinding{Runtime: owner, Subject: "subject_main"}}
	readback, err := second.Handle(context.Background(), "core.runtime_binding", json.RawMessage(`{}`))
	if err != nil || readback.(runtimebridge.Binding) != original {
		t.Fatal("new core facade reset the owner's generation or binding")
	}
	if _, err := second.Handle(context.Background(), "runtime.stop", json.RawMessage(`{"subjectId":"subject_main"}`)); err != nil {
		t.Fatal(err)
	}
	if answer, err := first.Handle(context.Background(), "core.runtime_binding", json.RawMessage(`{}`)); err == nil || answer != nil {
		t.Fatal("stopped authority still published a workbench binding")
	}
}

func TestRuntimeLocalAuthorityCancellationAndShutdownCannotSpawn(t *testing.T) {
	owner := runtimeowner.NewLocal()
	server := Serve{Runtime: owner, RuntimeBinding: &RuntimeBinding{Runtime: owner, Subject: "subject_main"}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	payload := startPayload(t, t.TempDir(), "must-not-execute", []string{}, `{"mode":"auto"}`)
	if result, err := server.Handle(ctx, "runtime.start", payload); err == nil || result != nil {
		t.Fatal("cancelled request reached a successful runtime launch")
	}
	view, present, err := owner.Status(context.Background(), "subject_main")
	if err != nil || present || view.PID != 0 {
		t.Fatal("cancelled authority request created a runtime record or child")
	}
	if err := owner.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	for method, body := range map[string]json.RawMessage{
		"runtime.start":        payload,
		"runtime.status":       json.RawMessage(`{"subjectId":"subject_main"}`),
		"runtime.stop":         json.RawMessage(`{"subjectId":"subject_main"}`),
		"runtime.console":      json.RawMessage(`{"cursor":0}`),
		"core.runtime_binding": json.RawMessage(`{}`),
	} {
		if result, err := server.Handle(context.Background(), method, body); !errors.Is(err, runtimeowner.ErrOwnerUnavailable) || result != nil {
			t.Fatalf("closed authority %s did not retain owner_unavailable without starting a replacement", method)
		}
	}
}
