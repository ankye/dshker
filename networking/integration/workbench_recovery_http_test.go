//go:build live

package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
)

type recoveryBrowser struct {
	client         *http.Client
	base           *url.URL
	html           [32]byte
	originalCookie [32]byte
	businessHTTP   atomic.Int64
	businessWS     atomic.Int64
	cookieExpiry   atomic.Int64
}

type recoveryCountedHTTP struct {
	transport *http.Transport
	writes    *atomic.Int64
	expiry    *atomic.Int64
}

func (transport recoveryCountedHTTP) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.writes.Add(1)
	response, err := transport.transport.RoundTrip(request)
	if response != nil {
		for _, cookie := range response.Cookies() {
			if !strings.HasPrefix(cookie.Name, "dsh-auth-") {
				continue
			}
			if cookie.Expires.IsZero() || cookie.MaxAge <= 0 {
				response.Body.Close()
				return nil, errors.New("test.explicit_cookie_expiry_required")
			}
			expires := cookie.Expires.Unix()
			for previous := transport.expiry.Load(); previous == 0 || expires < previous; previous = transport.expiry.Load() {
				if transport.expiry.CompareAndSwap(previous, expires) {
					break
				}
			}
		}
	}
	return response, err
}

type recoveryApplicationIdle struct {
	started time.Time
	http    int64
	ws      int64
	stream  *recoveryWS
	cookie  [32]byte
}

type recoveryIdleProof struct {
	ElapsedSeconds    float64 `json:"elapsedSeconds"`
	BusinessHTTPDelta int64   `json:"businessHTTPDelta"`
	BusinessWSDelta   int64   `json:"businessWSDelta"`
	OriginalWS        bool    `json:"originalWS"`
	SameCookie        bool    `json:"sameCookie"`
	WSID              string  `json:"wsId"`
}

func (browser *recoveryBrowser) cookieDigest(t *testing.T) [32]byte {
	t.Helper()
	digest, err := browser.currentCookieDigest()
	must(t, err)
	return digest
}

func (browser *recoveryBrowser) currentCookieDigest() ([32]byte, error) {
	cookies := browser.client.Jar.Cookies(browser.base)
	if len(cookies) == 0 {
		return [32]byte{}, errors.New("test.original_browser_cookie_lost")
	}
	encoded, err := json.Marshal(cookies)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(encoded), nil
}

func (browser *recoveryBrowser) originalCookieError() error {
	digest, err := browser.currentCookieDigest()
	if err != nil {
		return err
	}
	if browser.originalCookie == ([32]byte{}) || digest != browser.originalCookie {
		return errors.New("test.original_browser_cookie_replaced")
	}
	return nil
}

func (browser *recoveryBrowser) requireOriginalCookie(t *testing.T) {
	t.Helper()
	must(t, browser.originalCookieError())
}

func (browser *recoveryBrowser) beginIdle(t *testing.T, stream *recoveryWS) *recoveryApplicationIdle {
	t.Helper()
	stream.healthy(t)
	return &recoveryApplicationIdle{started: time.Now(), http: browser.businessHTTP.Load(), ws: browser.businessWS.Load(), stream: stream, cookie: browser.cookieDigest(t)}
}

func (browser *recoveryBrowser) endIdle(t *testing.T, idle *recoveryApplicationIdle, stream *recoveryWS, seconds int) recoveryIdleProof {
	t.Helper()
	proof := browser.idleProgress(t, idle, stream)
	if proof.ElapsedSeconds < float64(seconds) {
		t.Fatal("application idle did not reach its requested real duration")
	}
	return proof
}

func (browser *recoveryBrowser) requireCookieLifetime(t *testing.T, until int64) {
	t.Helper()
	if until <= time.Now().Unix() || browser.cookieExpiry.Load() < until {
		t.Fatal("actual original browser cookie expires before the requested scenario")
	}
	t.Logf("application-cookie-lifetime expiresAt=%d requiredUntil=%d noRefresh=true", browser.cookieExpiry.Load(), until)
}

func (browser *recoveryBrowser) idleProgress(t *testing.T, idle *recoveryApplicationIdle, stream *recoveryWS) recoveryIdleProof {
	t.Helper()
	stream.healthy(t)
	proof := recoveryIdleProof{
		ElapsedSeconds: time.Since(idle.started).Seconds(), BusinessHTTPDelta: browser.businessHTTP.Load() - idle.http,
		BusinessWSDelta: browser.businessWS.Load() - idle.ws, OriginalWS: idle.stream == stream,
		SameCookie: browser.cookieDigest(t) == idle.cookie, WSID: stream.id,
	}
	if proof.BusinessHTTPDelta != 0 || proof.BusinessWSDelta != 0 || !proof.OriginalWS || !proof.SameCookie {
		t.Fatalf("application idle did not retain a silent original browser: %s", recoveryJSON(t, proof))
	}
	return proof
}

type recoveryWorkspace struct {
	ID         string   `json:"workspaceId"`
	Path       string   `json:"path"`
	SessionIDs []string `json:"sessionIds"`
}

type recoveryFollowFrame struct {
	Type     string `json:"type"`
	StreamID string `json:"streamId"`
	Value    struct {
		Type  string `json:"type"`
		Value struct {
			Items []recoveryWorkspace `json:"items"`
		} `json:"value"`
	} `json:"value"`
}

// A browser continuously reads its WS, even without application activity. Each
// connection owns exactly one reader and a bounded inbox; neither a follow
// request's deadline nor a replacement connection owns this reader's lifetime.
type recoveryWS struct {
	connection *websocket.Conn
	id         string
	cancel     context.CancelFunc
	done       chan struct{}
	inbox      chan recoveryFollowFrame
	mu         sync.Mutex
	err        error
	appError   bool
	localClose bool
	expectLoss bool
	boundary   atomic.Pointer[recoveryWSBoundary]
	writes     *atomic.Int64
	log        func(string, ...any)
}

// The reader captures this boundary before acquiring mu. In particular, a
// reader waiting to publish its error cannot lose to a later local-close claim.
type recoveryWSBoundary struct {
	err        error
	appError   bool
	localClose bool
	sealed     bool
	capturedAt time.Time
}

func recoveryReadWS(t *testing.T, connection *websocket.Conn, writes *atomic.Int64) *recoveryWS {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	stream := &recoveryWS{connection: connection, id: protocol.NewID(), cancel: cancel, done: make(chan struct{}), inbox: make(chan recoveryFollowFrame, 256), writes: writes, log: t.Logf}
	go stream.read(ctx)
	t.Cleanup(func() {
		if err := stream.CloseNow(); err != nil {
			t.Errorf("owned WS cleanup failed ws=%s code=%s", stream.id, recoveryRedactRuntimeDiagnostic(err.Error()))
		}
		stream.mu.Lock()
		appError, failure := stream.appError, stream.err
		first := stream.boundary.Load()
		unexpected := failure != nil && !stream.expectLoss && (first == nil || !first.localClose)
		stream.mu.Unlock()
		if unexpected {
			t.Errorf("owned WS ended before cleanup ws=%s code=%s", stream.id, recoveryRedactRuntimeDiagnostic(failure.Error()))
		}
		if appError {
			t.Errorf("owned WS application error retained through cleanup ws=%s code=%s", stream.id, recoveryRedactRuntimeDiagnostic(failure.Error()))
		}
	})
	return stream
}

func (stream *recoveryWS) write(ctx context.Context, message []byte) error {
	stream.writes.Add(1)
	return stream.connection.Write(ctx, websocket.MessageText, message)
}

func (stream *recoveryWS) read(ctx context.Context) {
	defer close(stream.done)
	fail := func(err error, appError bool) {
		stream.publishFailure(stream.captureFailure(err, appError))
	}
	for {
		kind, message, err := stream.connection.Read(ctx)
		if err != nil {
			fail(err, false)
			return
		}
		var frame recoveryFollowFrame
		if kind != websocket.MessageText || json.Unmarshal(message, &frame) != nil || frame.Type != "item" || frame.StreamID == "" {
			fail(errors.New("test.ws_application_frame_rejected"), true)
			stream.connection.CloseNow()
			return
		}
		switch frame.Value.Type {
		case "baseline", "upsert", "remove", "order", "archived", "pinned":
		default:
			fail(errors.New("test.ws_workspace_frame_rejected"), true)
			stream.connection.CloseNow()
			return
		}
		select {
		case stream.inbox <- frame:
		default:
			fail(errors.New("test.ws_application_inbox_limit"), true)
			stream.connection.CloseNow()
			return
		}
	}
}

func (stream *recoveryWS) captureFailure(err error, appError bool) *recoveryWSBoundary {
	return stream.recordFailure(&recoveryWSBoundary{err: err, appError: appError, capturedAt: time.Now()})
}

func (stream *recoveryWS) recordFailure(failure *recoveryWSBoundary) *recoveryWSBoundary {
	for {
		first := stream.boundary.Load()
		if first != nil {
			if first.err != nil {
				return first
			}
			// Capturing the error and publishing its atomic boundary can itself
			// straddle a seal. A later close claim cannot relabel an earlier
			// captured error merely because its CAS happened to execute first.
			if failure.capturedAt.Before(first.capturedAt) {
				if stream.boundary.CompareAndSwap(first, failure) {
					return failure
				}
				continue
			}
			failure.localClose = first.localClose
			return failure
		}
		if stream.boundary.CompareAndSwap(nil, failure) {
			return failure
		}
	}
}

func (stream *recoveryWS) publishFailure(failure *recoveryWSBoundary) {
	stream.mu.Lock()
	if stream.err == nil {
		stream.err, stream.appError = failure.err, failure.appError
	}
	expected := stream.expectLoss
	stream.mu.Unlock()
	stream.log("test-ws-reader-ended ws=%s capturedAt=%s appError=%t localClose=%t expectedTransportLoss=%t code=%s", stream.id, failure.capturedAt.UTC().Format(time.RFC3339Nano), failure.appError, failure.localClose, expected, recoveryRedactRuntimeDiagnostic(failure.err.Error()))
}

// sealClose admits intentional teardown only while the current carrier is still
// healthy. It does not infer health from an earlier application readback.
func (stream *recoveryWS) sealClose() error {
	if first := stream.boundary.Load(); first != nil {
		return recoveryWSSealRefusal(first)
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.err != nil {
		return stream.err
	}
	if stream.appError {
		return errors.New("test.ws_application_failed_before_seal")
	}
	if stream.localClose || stream.expectLoss {
		return errors.New("test.ws_not_current_healthy_before_seal")
	}
	select {
	case <-stream.done:
		return errors.New("test.ws_reader_ended_before_seal")
	default:
	}
	sealed := &recoveryWSBoundary{localClose: true, sealed: true, capturedAt: time.Now()}
	if !stream.boundary.CompareAndSwap(nil, sealed) {
		return recoveryWSSealRefusal(stream.boundary.Load())
	}
	stream.localClose = true
	return nil
}

func recoveryWSSealRefusal(first *recoveryWSBoundary) error {
	if first.err != nil {
		return first.err
	}
	return errors.New("test.ws_already_closed_before_seal")
}

// SealCloseJoin is the business-acceptance acknowledgement: claim a healthy
// carrier, intentionally close it, and wait for its one reader before stopping
// the manager/runtime. Neither an early failure nor expected loss can be sealed.
func (stream *recoveryWS) SealCloseJoin() error {
	if err := stream.sealClose(); err != nil {
		return err
	}
	if err := stream.CloseNow(); err != nil {
		return err
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if first := stream.boundary.Load(); first.err != nil {
		return first.err
	}
	if stream.appError {
		return stream.err
	}
	stream.log("test-ws-acceptance-sealed ws=%s sealedAt=%s readerJoined=true", stream.id, stream.boundary.Load().capturedAt.UTC().Format(time.RFC3339Nano))
	return nil
}

func (stream *recoveryWS) healthy(t *testing.T) {
	t.Helper()
	stream.mu.Lock()
	err, localClose := stream.err, stream.localClose
	stream.mu.Unlock()
	if localClose {
		t.Fatalf("original owned WS was already closed by the test ws=%s", stream.id)
	}
	if err != nil {
		t.Fatalf("original owned WS failed ws=%s code=%s", stream.id, recoveryRedactRuntimeDiagnostic(err.Error()))
	}
}

func (stream *recoveryWS) CloseNow() error {
	stream.boundary.CompareAndSwap(nil, &recoveryWSBoundary{localClose: true, capturedAt: time.Now()})
	stream.mu.Lock()
	stream.localClose = true
	stream.mu.Unlock()
	stream.cancel()
	err := stream.connection.CloseNow()
	if errors.Is(err, net.ErrClosed) {
		err = nil // Already closed is the library's explicit idempotent-close result.
	}
	select {
	case <-stream.done:
		return err
	case <-time.After(5 * time.Second):
		return errors.New("test.ws_reader_cleanup_timeout")
	}
}

func recoveryOpenBrowser(t *testing.T, ctx context.Context, rawURL string) *recoveryBrowser {
	t.Helper()
	base, err := url.Parse(rawURL)
	must(t, err)
	if base.Hostname() != "127.0.0.1" || base.Scheme != "http" || base.Query().Get("token") == "" {
		t.Fatal("missing actual authenticated loopback gateway identity")
	}
	jar, err := cookiejar.New(nil)
	must(t, err)
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	browser := &recoveryBrowser{base: base}
	browser.client = &http.Client{
		Transport: recoveryCountedHTTP{transport: transport, writes: &browser.businessHTTP, expiry: &browser.cookieExpiry}, Jar: jar, Timeout: 10 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > 5 || request.URL.Host != base.Host || request.URL.Scheme != base.Scheme {
				return errors.New("test.gateway_redirect_rejected")
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	must(t, err)
	response, err := browser.client.Do(request)
	if requestError, ok := err.(*url.Error); ok {
		t.Fatalf("gateway authentication failed: %v", requestError.Err)
	}
	must(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	must(t, err)
	if response.StatusCode != http.StatusOK || !strings.Contains(strings.ToLower(string(body)), "<html") || !strings.Contains(string(body), "<script") || len(jar.Cookies(base)) == 0 {
		t.Fatal("gateway did not return the authenticated real DSH application and browser cookie")
	}
	browser.html = sha256.Sum256(body)
	browser.originalCookie = browser.cookieDigest(t)
	return browser
}

func (browser *recoveryBrowser) rpc(t *testing.T, ctx context.Context, method string, request any, result any) {
	t.Helper()
	browser.requireOriginalCookie(t)
	rpcID := protocol.NewID()
	encoded := recoveryJSON(t, map[string]any{
		"type": "client-request", "rpcId": rpcID, "method": method,
		"payload": map[string]any{"args": map[string]any{"request": request}},
	})
	httpRequest, err := http.NewRequestWithContext(ctx, "POST", browser.base.Scheme+"://"+browser.base.Host+"/api/"+method, strings.NewReader(encoded))
	must(t, err)
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Origin", browser.base.Scheme+"://"+browser.base.Host)
	response, err := browser.client.Do(httpRequest)
	must(t, err)
	defer response.Body.Close()
	browser.requireOriginalCookie(t)
	var answer struct {
		RPCID  string `json:"rpcId"`
		Result struct {
			OK    bool            `json:"ok"`
			Value json.RawMessage `json:"value"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		} `json:"result"`
	}
	must(t, json.NewDecoder(response.Body).Decode(&answer))
	if response.StatusCode != http.StatusOK || answer.RPCID != rpcID || !answer.Result.OK {
		t.Fatalf("real DSH %s reply status=%d rpcMatch=%t code=%s", method, response.StatusCode, answer.RPCID == rpcID, answer.Result.Error.Code)
	}
	must(t, json.Unmarshal(answer.Result.Value, result))
}

func (browser *recoveryBrowser) createSession(t *testing.T, ctx context.Context, project string) (recoveryWorkspace, string) {
	t.Helper()
	var created struct {
		Workspace recoveryWorkspace `json:"workspace"`
		Created   bool              `json:"created"`
	}
	browser.rpc(t, ctx, "workspace/create", map[string]any{"path": project}, &created)
	if created.Workspace.ID == "" || created.Workspace.Path != project {
		t.Fatal("real Workspace identity/path readback mismatch")
	}
	sessionID := "session-" + protocol.NewID()
	var session struct {
		ID string `json:"sessionId"`
	}
	browser.rpc(t, ctx, "session/create", map[string]any{"workspaceId": created.Workspace.ID, "sessionId": sessionID}, &session)
	if session.ID != sessionID {
		t.Fatal("real DSH returned another Session identity")
	}
	return created.Workspace, sessionID
}

func (browser *recoveryBrowser) follow(t *testing.T, ctx context.Context, workspace recoveryWorkspace, sessionID string) *recoveryWS {
	t.Helper()
	browser.requireOriginalCookie(t)
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(probeCtx, "ws://"+browser.base.Host+"/api/remote.mux", &websocket.DialOptions{
		HTTPClient: browser.client, HTTPHeader: http.Header{"Origin": []string{browser.base.Scheme + "://" + browser.base.Host}},
	})
	must(t, err)
	stream := recoveryReadWS(t, connection, &browser.businessWS)
	browser.requireOriginalCookie(t)
	browser.followOnConnection(t, probeCtx, stream, workspace, sessionID)
	return stream
}

func (browser *recoveryBrowser) followOnConnection(t *testing.T, ctx context.Context, stream *recoveryWS, workspace recoveryWorkspace, sessionID string) {
	t.Helper()
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	stream.healthy(t)
	streamID := protocol.NewID()
	must(t, stream.write(probeCtx, []byte(recoveryJSON(t, map[string]any{
		"type": "open", "streamId": streamID, "endpoint": "workspace/follow", "payload": map[string]any{"args": map[string]any{}},
	}))))
	for {
		var frame recoveryFollowFrame
		select {
		case frame = <-stream.inbox:
			stream.healthy(t)
		case <-stream.done:
			stream.healthy(t)
			t.Fatal("owned WS reader ended without an error")
		case <-probeCtx.Done():
			t.Fatal("actual workspace/follow WS did not return its new correlated baseline within 10s")
		}
		if frame.StreamID != streamID {
			continue // Other still-open streams share this same real WS.
		}
		if frame.Value.Type != "baseline" {
			t.Fatal("actual workspace/follow WS did not return the correlated baseline")
		}
		for _, item := range frame.Value.Value.Items {
			if item.ID == workspace.ID && item.Path == workspace.Path && slices.Contains(item.SessionIDs, sessionID) {
				t.Logf("real-ws-readback workspace=%s session=%s stream=%s ws=%s", workspace.ID, sessionID, streamID, stream.id)
				return
			}
		}
		t.Fatal("actual WS baseline lost the original Workspace path or Session identity")
	}
}

func (browser *recoveryBrowser) readback(t *testing.T, ctx context.Context, workspace recoveryWorkspace, sessionID string) *recoveryWS {
	t.Helper()
	browser.readbackHTTP(t, ctx, workspace, sessionID)
	return browser.follow(t, ctx, workspace, sessionID)
}

func (browser *recoveryBrowser) readbackExisting(t *testing.T, ctx context.Context, workspace recoveryWorkspace, sessionID string, connection *recoveryWS) {
	t.Helper()
	connection.healthy(t)
	browser.readbackHTTP(t, ctx, workspace, sessionID)
	browser.followOnConnection(t, ctx, connection, workspace, sessionID)
}

func (browser *recoveryBrowser) readbackHTTP(t *testing.T, ctx context.Context, workspace recoveryWorkspace, sessionID string) {
	t.Helper()
	browser.requireOriginalCookie(t)
	request, err := http.NewRequestWithContext(ctx, "GET", browser.base.Scheme+"://"+browser.base.Host+"/", nil)
	must(t, err)
	response, err := browser.client.Do(request)
	must(t, err)
	browser.requireOriginalCookie(t)
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	response.Body.Close()
	must(t, err)
	if response.StatusCode != http.StatusOK || sha256.Sum256(body) != browser.html {
		t.Fatal("original browser cookie did not recover the same actual DSH application content")
	}
	// Idempotent resolution is a real API readback of the original registration.
	var resolved struct {
		Workspace recoveryWorkspace `json:"workspace"`
		Created   bool              `json:"created"`
	}
	browser.rpc(t, ctx, "workspace/create", map[string]any{"path": workspace.Path}, &resolved)
	if resolved.Created || resolved.Workspace.ID != workspace.ID || resolved.Workspace.Path != workspace.Path || !slices.Contains(resolved.Workspace.SessionIDs, sessionID) {
		t.Fatal("HTTP readback replaced the original Workspace/Session registration")
	}
}

func (browser *recoveryBrowser) detached(t *testing.T, ctx context.Context) {
	t.Helper()
	browser.requireOriginalCookie(t)
	request, err := http.NewRequestWithContext(ctx, "GET", browser.base.Scheme+"://"+browser.base.Host+"/", nil)
	must(t, err)
	response, err := browser.client.Do(request)
	must(t, err)
	defer response.Body.Close()
	browser.requireOriginalCookie(t)
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	must(t, err)
	if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "p2p.stream_failed") || strings.Contains(string(body), "<script") {
		t.Fatalf("detached gateway did not reject stale application content: status=%d", response.StatusCode)
	}
}
