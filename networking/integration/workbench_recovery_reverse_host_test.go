//go:build live

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peersession"
)

// These are test observations, not a production peer response. Credentials and
// gateway URLs never leave the Mac role which owns this browser cookie jar.
type recoveryReverseStatus struct {
	Opened                  bool               `json:"opened"`
	State                   peersession.State  `json:"state"`
	WorkspaceID             string             `json:"workspaceId"`
	SessionID               string             `json:"sessionId"`
	WSID                    string             `json:"wsId"`
	Readbacks               int                `json:"readbacks"`
	ApplicationIdle         *recoveryIdleProof `json:"applicationIdle,omitempty"`
	ApplicationIdleProgress *recoveryIdleProof `json:"applicationIdleProgress,omitempty"`
}

type recoveryReverseBrowser struct {
	manager    *peersession.Manager
	events     <-chan peersession.State
	pair       string
	current    peersession.State
	url        string
	browser    *recoveryBrowser
	workspace  recoveryWorkspace
	session    string
	stream     *recoveryWS
	wsID       string
	readbacks  int
	seen       map[string]bool
	idle       *recoveryApplicationIdle
	idleProof  *recoveryIdleProof
	idleSample *recoveryIdleProof
}

func recoveryOpenReverse(t *testing.T, ctx context.Context, manager *peersession.Manager, events <-chan peersession.State, pair, project string) *recoveryReverseBrowser {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	first, err := manager.Connect(deadline, pair, uint64(time.Now().UnixMilli()), true)
	must(t, err)
	if first.State.Stage != "ready" || first.State.PairID != pair || first.State.AttemptID == "" || first.State.RuntimeGeneration == 0 || first.URL == "" {
		t.Fatalf("reverse initial identity was not ready: %s", recoveryJSON(t, first.State))
	}
	browser := recoveryOpenBrowser(t, deadline, first.URL)
	workspace, session := browser.createSession(t, deadline, project)
	reverse := &recoveryReverseBrowser{
		manager: manager, events: events, pair: pair, current: first.State, url: first.URL,
		browser: browser, workspace: workspace, session: session,
		seen: map[string]bool{first.State.AttemptID: true},
	}
	reverse.openStream(t, deadline)
	return reverse
}

func (reverse *recoveryReverseBrowser) status() *recoveryReverseStatus {
	return &recoveryReverseStatus{
		Opened: true, State: reverse.current, WorkspaceID: reverse.workspace.ID,
		SessionID: reverse.session, WSID: reverse.wsID, Readbacks: reverse.readbacks,
		ApplicationIdle:         reverse.idleProof,
		ApplicationIdleProgress: reverse.idleSample,
	}
}

func (reverse *recoveryReverseBrowser) progressIdle(t *testing.T, macPID int) {
	t.Helper()
	if reverse.idle == nil || reverse.idleProof != nil {
		t.Fatal("reverse idle progress requires the original active interval")
	}
	proof := reverse.browser.idleProgress(t, reverse.idle, reverse.stream)
	entry, err := reverse.manager.Entry(reverse.pair, reverse.current.Generation)
	must(t, err)
	if entry.State != reverse.current || entry.URL != reverse.url || reverse.wsID != proof.WSID {
		t.Fatal("reverse idle progress changed its original attempt or WS")
	}
	reverse.idleSample = &proof
	t.Logf("application-idle-progress direction=mac-to-windows elapsedSeconds=%.6f businessHTTPDelta=%d businessWSDelta=%d originalWS=%t ws=%s pair=%s attempt=%s generation=%d runtimeGeneration=%d macRuntimePid=%d workspace=%s session=%s", proof.ElapsedSeconds, proof.BusinessHTTPDelta, proof.BusinessWSDelta, proof.OriginalWS, proof.WSID, reverse.pair, reverse.current.AttemptID, reverse.current.Generation, reverse.current.RuntimeGeneration, macPID, reverse.workspace.ID, reverse.session)
}

func (reverse *recoveryReverseBrowser) beginIdle(t *testing.T, ctx context.Context, seconds, macPID int) {
	t.Helper()
	if reverse.idle != nil || reverse.idleProof != nil {
		t.Fatal("reverse application idle must begin exactly once")
	}
	entry, err := reverse.manager.Entry(reverse.pair, reverse.current.Generation)
	must(t, err)
	if entry.State != reverse.current || entry.URL != reverse.url || reverse.stream.id != reverse.wsID {
		t.Fatal("reverse idle did not begin on the original gateway and connection")
	}
	reverse.idle = reverse.browser.beginIdle(t, reverse.stream)
	t.Logf("idle-begin direction=mac-to-windows requiredSeconds=%d startedAt=%s ws=%s pair=%s attempt=%s generation=%d macRuntimePid=%d workspace=%s session=%s cookieSha256=%x", seconds, reverse.idle.started.UTC().Format(time.RFC3339Nano), reverse.wsID, reverse.pair, reverse.current.AttemptID, reverse.current.Generation, macPID, reverse.workspace.ID, reverse.session, reverse.idle.cookie)
}

func (reverse *recoveryReverseBrowser) endIdle(t *testing.T, ctx context.Context, seconds int) {
	t.Helper()
	if reverse.idle == nil || reverse.idleProof != nil {
		t.Fatal("reverse application idle must end its one active interval")
	}
	proof := reverse.browser.endIdle(t, reverse.idle, reverse.stream, seconds)
	entry, err := reverse.manager.Entry(reverse.pair, reverse.current.Generation)
	must(t, err)
	if entry.State != reverse.current || entry.URL != reverse.url || reverse.wsID != proof.WSID {
		t.Fatal("reverse application idle changed its gateway, attempt, or original WS")
	}
	reverse.readback(t, ctx)
	if reverse.browser.cookieDigest(t) != reverse.idle.cookie {
		t.Fatal("reverse idle readback replaced the original cookie")
	}
	reverse.idleProof = &proof
	t.Logf("duplex-application-idle direction=mac-to-windows elapsedSeconds=%.6f businessHTTPDelta=%d businessWSDelta=%d originalWS=%t ws=%s pair=%s attempt=%s generation=%d workspace=%s session=%s", proof.ElapsedSeconds, proof.BusinessHTTPDelta, proof.BusinessWSDelta, proof.OriginalWS, proof.WSID, reverse.pair, reverse.current.AttemptID, reverse.current.Generation, reverse.workspace.ID, reverse.session)
}

func (reverse *recoveryReverseBrowser) openStream(t *testing.T, ctx context.Context) {
	t.Helper()
	reverse.stream = reverse.browser.readback(t, ctx, reverse.workspace, reverse.session)
	reverse.wsID = reverse.stream.id
	reverse.readbacks++
}

func (reverse *recoveryReverseBrowser) readback(t *testing.T, ctx context.Context) {
	t.Helper()
	entry, err := reverse.manager.Entry(reverse.pair, reverse.current.Generation)
	must(t, err)
	if entry.State != reverse.current || entry.URL != reverse.url || reverse.stream == nil {
		t.Fatal("unaffected reverse direction changed attempt, generation, gateway, or original WS")
	}
	reverse.browser.readbackExisting(t, ctx, reverse.workspace, reverse.session, reverse.stream)
	reverse.readbacks++
	t.Logf("reverse-original-ws serviceDirection=mac-to-windows pair=%s attempt=%s generation=%d ws=%s workspace=%s session=%s", reverse.pair, reverse.current.AttemptID, reverse.current.Generation, reverse.wsID, reverse.workspace.ID, reverse.session)
}

// Read-only observation of the production Engine/Manager. The first explicit
// open alone grants workbench intent; this observer never connects or retries.
func (reverse *recoveryReverseBrowser) awaitRecovery(t *testing.T, ctx context.Context, auto recoveryNetworkAutoOwner, stage string) {
	t.Helper()
	previous := reverse.current
	cookie := reverse.browser.cookieDigest(t)
	if reverse.stream != nil {
		waitDisconnected(t, ctx, reverse.events, previous.AttemptID)
		reverse.browser.detached(t, ctx)
		assertRecoveryStreamClosed(t, ctx, reverse.stream)
		reverse.stream = nil
	} else {
		reverse.browser.detached(t, ctx)
	}
	deadline, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	var current peersession.State
waiting:
	for {
		state, present := auto.Current()
		if present && state.PairID == reverse.pair && state.Generation > previous.Generation && state.Stage == stage {
			current = state
			break waiting
		}
		select {
		case <-deadline.Done():
			t.Fatal("production automatic reverse recovery missed its unchanged 25s observation deadline")
		case <-ticker.C:
		}
	}
	if current.AttemptID == "" || reverse.seen[current.AttemptID] || auto.Attempts() == 0 {
		t.Fatal("reverse recovery reused an old attempt or changed its scoped identity")
	}
	reverse.seen[current.AttemptID] = true
	reverse.current = current
	if current.Stage == "ready" {
		entry, err := reverse.manager.Entry(reverse.pair, current.Generation)
		must(t, err)
		if entry.State != current || entry.URL != reverse.url {
			t.Fatal("reverse recovery moved the original authenticated gateway")
		}
		reverse.openStream(t, deadline)
	} else if current.Stage == "connected" && current.Error == "p2p.runtime_unavailable" && current.RuntimeGeneration == 0 {
		reverse.browser.detached(t, deadline)
	} else {
		t.Fatalf("reverse recovery lost its exact runtime refusal: %s", recoveryJSON(t, current))
	}
	if reverse.browser.cookieDigest(t) != cookie {
		t.Fatal("automatic reverse readback replaced its original cookie")
	}
	t.Logf("reverse-manager-state trigger=production-autoconnect-engine observerOnly=true engineAttempts=%d state=%s", auto.Attempts(), recoveryJSON(t, current))
}
