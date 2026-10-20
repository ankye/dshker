package peersession

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
	"github.com/coder/websocket"
)

func (f *graceFixture) control(t *testing.T) {
	t.Helper()
	var cancelled atomic.Bool
	control, _, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := pendingCandidateState(*f.next.ticket)
		state.FromReady, state.ToReady = true, true
		switch r.URL.Path {
		case "/v2/candidates/ready":
			f.ready.Add(1)
		case "/v2/candidates/commit":
			f.commit.Add(1)
			state = committedHandoffState(*f.next.ticket)
		case "/v2/candidates/cancel":
			cancelled.Store(true)
		case "/v2/candidates/state":
		case "/v2/end":
			var request protocol.EndCandidate
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			json.NewEncoder(w).Encode(protocol.EndResult{AttemptID: f.next.lease.AttemptID, Generation: f.next.lease.Generation, Reason: request.Reason, Ended: true})
			return
		default:
			t.Error("unexpected grace control operation", r.URL.Path)
		}
		if cancelled.Load() {
			state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
		}
		json.NewEncoder(w).Encode(state)
	}))
	f.manager.client = control.client
}

func TestCandidateGraceBothEndpointsPublishReadyOnlyAfterTerminal(t *testing.T) {
	for _, initiator := range []bool{true, false} {
		t.Run(map[bool]string{true: "initiated", false: "answered"}[initiator], func(t *testing.T) {
			f := newGraceFixture(t, initiator)
			f.control(t)
			gate := f.wait(t)
			if _, err := f.manager.readyCandidateReceipt(f.next); err == nil {
				t.Fatal("waiting endpoint admitted a direct Ready dispatch")
			}
			if f.ready.Load() != 0 || f.commit.Load() != 0 {
				t.Fatal("waiting endpoint published readiness")
			}
			f.old.cancel()
			graceResult(t, f.manager.ctx, gate, "")
			if err := f.manager.readyCandidate(f.next); err != nil {
				t.Fatal(err)
			}
			if f.ready.Load() != 1 || f.commit.Load() != 0 {
				t.Fatal("terminal boundary did not admit exactly this endpoint's Ready")
			}
		})
	}
}

func TestCandidateGraceFinalReadyAndCommitBarriersRejectScopeChange(t *testing.T) {
	f := newGraceFixture(t, true)
	f.control(t)
	gate := f.wait(t)
	f.old.cancel()
	graceResult(t, f.manager.ctx, gate, "")
	f.manager.mu.Lock()
	pin := f.manager.pins[f.pairID]
	pin.Pair.Revision++
	f.manager.pins[f.pairID] = pin
	commitErr := f.manager.candidateGraceCommitLocked(f.next)
	f.manager.mu.Unlock()
	if _, err := f.manager.readyCandidateReceipt(f.next); err == nil || commitErr == nil {
		t.Fatal("scope changed after wait crossed Ready or Commit admission", err, commitErr)
	}
	if f.ready.Load() != 0 || f.commit.Load() != 0 {
		t.Fatal("stale owner dispatched a wire mutation")
	}
}

func TestCandidateGraceEarlyDecisionObserverRetainsItsOwnerWhileWaiting(t *testing.T) {
	f := newGraceFixture(t, true)
	observed := make(chan struct{})
	control, _, _ := controlCandidateManager(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/candidates/state" {
			t.Error("waiting observer dispatched an unexpected mutation", r.URL.Path)
		}
		state := pendingCandidateState(*f.next.ticket)
		state.Decision.Status, state.Decision.Reason, state.Decision.DecidedAt = "cancelled", "p2p.candidate_cancelled", time.Now().Unix()
		json.NewEncoder(w).Encode(state)
		close(observed)
	}))
	f.manager.client = control.client
	observer := f.manager.startCandidateDecisionObserver(f.next)
	t.Cleanup(func() { observer.stop() })
	done := f.wait(t)
	f.next.notify() // Only the existing observer consumes this control notification.
	select {
	case <-observed:
	case <-f.manager.ctx.Done():
		t.Fatal(f.manager.ctx.Err())
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("terminal observer decision was lost")
		}
	case <-f.manager.ctx.Done():
		t.Fatal(f.manager.ctx.Err())
	}
	observer.stop()
	if f.next.graceOwner == nil || f.old.ctx.Err() != nil {
		t.Fatal("decision observer changed the predecessor or lost its gate owner")
	}
}

func TestCandidateGraceDoesNotReopenGateAfterCommitDispatch(t *testing.T) {
	f := newGraceFixture(t, true)
	gate := f.wait(t)
	f.manager.mu.Lock()
	f.next.commitDispatched = true
	f.manager.mu.Unlock()
	// A dispatched commit is resolved by its durable receipt, even when local
	// recovery asks to cancel. No local owner can declare the remote CAS undone.
	f.next.requestCancel()
	graceResult(t, f.manager.ctx, gate, "")
	if err := f.manager.awaitCandidateGrace(f.next); err != nil {
		t.Fatal("commit dispatch re-entered precommit grace", err)
	}
}

func TestCandidateGraceMalformedCommittedDecisionCannotReleaseReady(t *testing.T) {
	for _, invalid := range []string{"from-not-ready", "to-not-ready", "active-attempt", "active-generation"} {
		t.Run(invalid, func(t *testing.T) {
			f := newGraceFixture(t, true)
			f.control(t)
			done := f.wait(t)
			state := committedHandoffState(*f.next.ticket)
			switch invalid {
			case "from-not-ready":
				state.FromReady = false
			case "to-not-ready":
				state.ToReady = false
			case "active-attempt":
				state.CurrentActiveAttemptID = protocol.NewNonce()
			case "active-generation":
				state.CurrentActiveGeneration++
			}
			// These signed metadata fields pass historical receipt validation;
			// only exact live committed admission may release this local gate.
			if err := f.manager.validateCandidateState(f.next, state); err != nil {
				t.Fatal(err)
			}
			if candidateGraceCommitted(f.next) {
				t.Fatal("incomplete committed decision released the recovery gate")
			}
			if _, err := f.manager.readyCandidateReceipt(f.next); err == nil {
				t.Fatal("incomplete committed decision admitted Ready")
			}
			if f.ready.Load() != 0 || f.commit.Load() != 0 {
				t.Fatal("malformed committed decision dispatched a mutation")
			}
			f.old.cancel()
			graceResult(t, f.manager.ctx, done, "")
		})
	}
}

func TestCandidateGraceRecoveredPrimaryRetainsRealPionHTTPAndOriginalWebSocket(t *testing.T) {
	fixture := newBrowserCandidateFixture(t)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/remote.mux" {
			http.SetCookie(w, &http.Cookie{Name: "runtime", Value: "grace-cookie", Path: "/"})
			io.WriteString(w, "original-grace-workbench")
			return
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"127.0.0.1:*"}})
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for {
			kind, body, err := ws.Read(r.Context())
			if err != nil {
				return
			}
			if err := ws.Write(r.Context(), kind, body); err != nil {
				return
			}
		}
	}))
	t.Cleanup(runtime.Close)
	old := fixture.promote(t, 1, runtimebridge.Binding{Generation: 1, URL: runtime.URL + "/?token=grace-test"}, "")
	entry := old.endpoint.LocalURL()
	initialMux, initialAttempt := old.mux, old.lease.AttemptID
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: time.Second}
	response, err := client.Get(entry)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	local, err := url.Parse(entry)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(fixture.manager.ctx, 3*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+local.Host+"/api/remote.mux", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	next := prepareGraceResume(t, fixture, 2)
	remote := fixture.transports(t, next)
	f := &graceFixture{browserCandidateFixture: fixture, old: old, next: next}
	f.control(t)
	target := graceCandidateTarget(t, f, remote, runtimebridge.Binding{Generation: 1, URL: runtime.URL + "/?token=grace-test"})
	go fixture.manager.runCandidate(next, true)
	select {
	case <-next.done:
	case <-ctx.Done():
		t.Fatal("candidate did not join after exact predecessor recovery", ctx.Err())
	}
	select {
	case err := <-target:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("target negotiation did not join", ctx.Err())
	}
	fixture.manager.endWait.Wait()
	if f.ready.Load() != 0 || f.commit.Load() != 0 || !next.cancellationRequested() {
		t.Fatal("production candidate runner published Ready before canceling recovered predecessor")
	}
	if err := ws.Write(ctx, websocket.MessageText, []byte("same-original-stream")); err != nil {
		t.Fatal(err)
	}
	_, body, err := ws.Read(ctx)
	if err != nil || string(body) != "same-original-stream" {
		t.Fatal("original WS was replaced or lost", string(body), err)
	}
	assertBrowserWorkbenchResponse(t, entry, http.StatusOK, "original-grace-workbench")
	if old.mux != initialMux || old.lease.AttemptID != initialAttempt || old.endpoint.CurrentMux() != initialMux || fixture.manager.sessions[fixture.pairID] != old {
		t.Fatal("recovery changed original attempt, mux or browser endpoint")
	}
	t.Log("real Pion HTTP and same open WS retained original cookie, mux, attempt and gateway; local regression only")
}
