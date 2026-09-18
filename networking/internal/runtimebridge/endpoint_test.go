package runtimebridge

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
)

// A browser tab left open on the gateway address must keep working after the
// direct path is rebuilt. Before the endpoint indirection the gateway died
// with its session and the next connect allocated a new loopback port, so the
// user's URL silently became dead — the reason a reconnect was only usable
// from inside the app, never from a real browser.
func TestBrowserGatewayKeepsItsURLAcrossSessions(t *testing.T) {
	ctx, left, right := directMuxes(t)

	served := make(chan struct{}, 8)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served <- struct{}{}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("runtime-body"))
	}))
	defer runtime.Close()
	binding := Binding{Generation: 7, URL: runtime.URL + "/?token=endpoint-test-token"}

	// The target side answers streams the gateway opens.
	go func() {
		attachment, err := NewEndpoint(right, binding)
		if err != nil {
			return
		}
		target, err := ServeTargetEndpoint(ctx, attachment)
		if err != nil {
			return
		}
		<-target.Done()
	}()

	attachment, err := NewEndpoint(left, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	gateway, err := OpenBrowserEndpoint(ctx, attachment)
	if err != nil {
		t.Fatalf("gateway: %v", err)
	}
	defer gateway.Close()
	first := gateway.URL

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Timeout: 20 * time.Second, Jar: jar}
	response, err := client.Get(first)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("first request status %d", response.StatusCode)
	}

	// The session drops. The gateway must stay on its address, and a request
	// sent during the gap must fail cleanly rather than reach a dead mux. The
	// gateway's ErrorHandler turns every stream failure into a 502 so a
	// browser sees a clean server error instead of a hung connection; the Go
	// client call itself still succeeds at the HTTP level.
	if !attachment.Detach(left) {
		t.Fatal("current session was not detached")
	}
	if gateway.URL != first {
		t.Fatalf("URL changed on drop: %s want %s", gateway.URL, first)
	}
	response, err = client.Get(first)
	if err != nil {
		t.Fatalf("request during reconnection: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("request during reconnection status %d, want 502", response.StatusCode)
	}

	// The shell rebuilds the session and hands it to the same endpoint.
	if err = attachment.Replace(left, binding); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if gateway.URL != first {
		t.Fatalf("URL changed after reconnect: %s want %s", gateway.URL, first)
	}
	response, err = client.Get(first)
	if err != nil {
		t.Fatalf("request after reconnect: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("request after reconnect status %d", response.StatusCode)
	}
	if len(served) < 2 {
		t.Fatalf("runtime served %d requests, want the one before and the one after", len(served))
	}
}

// A closed endpoint must not accept a later session: the gateway is gone and
// its port released, so attaching would silently do nothing.
func TestClosedEndpointRefusesLaterSessions(t *testing.T) {
	_, left, _ := directMuxes(t)
	binding := Binding{Generation: 7, URL: "http://127.0.0.1:1/?token=t"}
	attachment, err := NewEndpoint(left, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	attachment.Close()
	if err = attachment.Replace(left, binding); err == nil {
		t.Fatal("a closed endpoint accepted a session")
	}
	if _, err = attachment.open(); err == nil {
		t.Fatal("a closed endpoint opened a stream")
	}
}

// A superseded run can finish after its replacement is already ready. Its
// cleanup owns only the old mux and must not detach the replacement from the
// long-lived endpoint.
func TestStaleDetachPreservesReplacement(t *testing.T) {
	_, oldMux, _ := directMuxes(t)
	_, newMux, _ := directMuxes(t)
	binding := Binding{Generation: 7, URL: "http://127.0.0.1:1/?token=t"}
	attachment, err := NewEndpoint(oldMux, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	if err = attachment.Replace(newMux, binding); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if attachment.Detach(oldMux) {
		t.Fatal("stale session detached its replacement")
	}
	attachment.mu.RLock()
	current := attachment.mux
	attachment.mu.RUnlock()
	if current != newMux {
		t.Fatal("stale cleanup changed the current mux")
	}
	if !attachment.Detach(newMux) {
		t.Fatal("current replacement could not detach itself")
	}
}

// ServeTargetEndpoint must serve for as long as the pair is meant to be
// reachable, independent of any one session: replacing the mux keeps the
// same http.Server running rather than needing the caller to notice Serve
// died and start a new one.
func TestServeTargetEndpointSurvivesSessionReplacement(t *testing.T) {
	ctx, left, right := directMuxes(t)

	served := make(chan struct{}, 8)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served <- struct{}{}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("runtime-body"))
	}))
	defer runtime.Close()
	binding := Binding{Generation: 7, URL: runtime.URL + "/?token=serve-target-test-token"}

	attachment, err := NewEndpoint(right, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	gateway, err := ServeTargetEndpoint(ctx, attachment)
	if err != nil {
		t.Fatalf("serve target: %v", err)
	}
	defer gateway.Close()
	target, err := binding.Endpoint()
	if err != nil {
		t.Fatalf("binding endpoint: %v", err)
	}

	// The initiator side dials through `left` via an http.Client, exercising
	// the real admission path rather than calling the gateway in-process.
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(dialCtx context.Context, network, address string) (net.Conn, error) {
			stream, err := left.Open()
			if err != nil {
				return nil, err
			}
			return peer.NewConn(ctx, stream), nil
		},
	}}
	requestOnce := func() {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, "http://placeholder/", nil)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		request.Host = target.Host
		request.URL.RawQuery = target.RawQuery
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("runtime-body")) {
			t.Fatalf("unexpected response %d: %s", response.StatusCode, body)
		}
	}
	requestOnce()

	// The session drops; the endpoint is detached but the gateway keeps
	// running.
	if !attachment.Detach(right) {
		t.Fatal("current target session was not detached")
	}
	time.Sleep(20 * time.Millisecond)

	// A fresh mux pair stands in for the rebuilt session and is attached to
	// the same endpoint.
	_, newLeft, newRight := directMuxes(t)
	if err = attachment.Replace(newRight, binding); err != nil {
		t.Fatalf("replace: %v", err)
	}
	left = newLeft
	requestOnce()
	if len(served) < 2 {
		t.Fatalf("runtime served %d requests, want the one before and the one after", len(served))
	}
}

// With the gateway kept across sessions, a detached endpoint must still
// refuse to reach the peer runtime: the port stays bound so the URL survives
// a reconnect, but nothing may be proxied until a session is attached again.
func TestDetachedGatewayServesNoRuntimeContent(t *testing.T) {
	ctx, left, right := directMuxes(t)
	var reached int32
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reached, 1)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("secret-runtime-body"))
	}))
	defer runtime.Close()
	binding := Binding{Generation: 7, URL: runtime.URL + "/?token=detached-test-token"}
	go func() {
		attachment, err := NewEndpoint(right, binding)
		if err != nil {
			return
		}
		target, err := ServeTargetEndpoint(ctx, attachment)
		if err != nil {
			return
		}
		<-target.Done()
	}()
	attachment, err := NewEndpoint(left, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	gateway, err := OpenBrowserEndpoint(ctx, attachment)
	if err != nil {
		t.Fatalf("gateway: %v", err)
	}
	defer gateway.Close()

	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(gateway.URL)
	if err != nil {
		t.Fatalf("attached request: %v", err)
	}
	response.Body.Close()
	before := atomic.LoadInt32(&reached)
	if before == 0 {
		t.Fatal("an attached gateway did not reach the runtime")
	}

	if !attachment.Detach(left) {
		t.Fatal("current browser session was not detached")
	}
	response, err = client.Get(gateway.URL)
	if err != nil {
		t.Fatalf("detached request: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode == http.StatusOK {
		t.Fatalf("a detached gateway served a success: %s", body)
	}
	if bytes.Contains(body, []byte("secret-runtime-body")) {
		t.Fatal("a detached gateway served runtime content")
	}
	if after := atomic.LoadInt32(&reached); after != before {
		t.Fatalf("a detached gateway reached the runtime %d more times", after-before)
	}
}

// The gateway's listener is owned by the long-lived context, not the session's.
// This is what keeps a browser URL stable: cancelling one session must detach
// the endpoint without releasing the loopback port a tab is still pointed at.
func TestGatewayPortSurvivesSessionContextCancel(t *testing.T) {
	_, left, right := directMuxes(t)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("runtime-body"))
	}))
	defer runtime.Close()
	binding := Binding{Generation: 7, URL: runtime.URL + "/?token=session-lifetime-token"}

	// The gateway context stands in for the pair's lifetime: the port is
	// allocated once and kept for as long as the pair is reachable.
	gatewayCtx, cancelGateway := context.WithCancel(context.Background())
	defer cancelGateway()

	// The target side answers the streams the gateway opens.
	targetAttachment, err := NewEndpoint(right, binding)
	if err != nil {
		t.Fatalf("target endpoint: %v", err)
	}
	if _, err = ServeTargetEndpoint(gatewayCtx, targetAttachment); err != nil {
		t.Fatalf("serve target: %v", err)
	}

	attachment, err := NewEndpoint(left, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	gateway, err := OpenBrowserEndpoint(gatewayCtx, attachment)
	if err != nil {
		t.Fatalf("gateway: %v", err)
	}
	url := gateway.URL

	// The session ends; the tab's port must remain bound.
	if !attachment.Detach(left) {
		t.Fatal("current browser session was not detached")
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("port released when a session ended: %v", err)
	}
	response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		t.Fatal("a detached gateway served runtime content")
	}

	// Only ending the gateway's own lifetime closes it.
	cancelGateway()
	deadline := time.Now().Add(2 * time.Second)
	for {
		response, err = client.Get(url)
		if err != nil {
			break
		}
		response.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("the gateway outlived its own context")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A connection's URL must be this machine's gateway address, never the
// binding's URL: the latter is the *peer's* loopback runtime address, which
// means nothing here. Reporting it sent callers to a port on the wrong
// machine — and after a reconnect there is no fresh gateway to read it from.
func TestEndpointReportsItsOwnGatewayURL(t *testing.T) {
	ctx, left, _ := directMuxes(t)
	binding := Binding{Generation: 7, URL: "http://127.0.0.1:59999/?token=peer-side-token"}
	attachment, err := NewEndpoint(left, binding)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	if got := attachment.LocalURL(); got != "" {
		t.Fatalf("an endpoint without a gateway reported %q", got)
	}
	gateway, err := OpenBrowserEndpoint(ctx, attachment)
	if err != nil {
		t.Fatalf("gateway: %v", err)
	}
	defer gateway.Close()

	local := attachment.LocalURL()
	if local != gateway.URL {
		t.Fatalf("endpoint reported %q, gateway serves %q", local, gateway.URL)
	}
	if strings.Contains(local, "59999") {
		t.Fatalf("endpoint reported the peer's runtime address: %q", local)
	}
	// The peer's binding is still readable for its identity, just never as
	// this machine's address.
	current, err := attachment.Binding()
	if err != nil || current.Generation != 7 {
		t.Fatalf("binding readback: %+v %v", current, err)
	}
	// The address survives a session drop, which is the point of the design.
	if !attachment.Detach(left) {
		t.Fatal("current browser session was not detached")
	}
	if after := attachment.LocalURL(); after != local {
		t.Fatalf("address changed on detach: %q → %q", local, after)
	}
}
