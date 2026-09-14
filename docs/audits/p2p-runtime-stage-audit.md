# Audit — the runtime / desktop stage of the DSHKer P2P connection

Scope: everything that happens **after** the peer transport reaches `WaitReady` — `runtimebridge.Establish`, the `runtime.connect` owner callback, the core's local DSH Web supervision, the loopback gateway, and what the peer's Run page actually renders.

Read-only audit; no repository file was modified. Line numbers are as of the working tree at audit time.

---

## 0. The chain in one page

```
initiator manager.run()                              target (the "desktop")
  transport.WaitReady()
  state.Stage = "starting-runtime"  ── emit peer.state ──▶ shell: #states[key].stage = starting-runtime
  Establish()                                          (required gate for the callback below)
    sendHello(runtime.connect)  ──────────────────────▶ readHello()
                                                         owner(budget, lease.FromDeviceID)
                                                           helper/host.go owner closure
                                                             main.Call("runtime.connect",{serviceId,pairId})
                                                               TS PeerRuntimeHost.#handle
                                                                 #authorize(pairId in catalog, active)
                                                                 PeerRuntimeOwner.connect(signal)
                                                                   source.start() → core runtime.start → DSH Web child
                                                                   waits for kind==='running' url (70 s cap)
                                                                   assertCurrent(binding)
                                                             decode Binding{generation,url}
                                                           binding.Endpoint() validates loopback+token
                                                         sendHello(runtime.result, gen, url)
    readHello() → Binding
    binding.Endpoint() validates
    peer.NewMux(transport, RuntimeGeneration=gen)
    if attachment==nil: NewEndpoint + OpenBrowserEndpoint (loopback gateway, stable URL)
    else: attachment.Replace(mux, binding)
  Probe(readyURL)  ← HTTP 200 + cookie + ws /api/remote.mux through the tunnel
  state.Stage = "ready"; state.RuntimeGeneration = gen; Connected.URL = gateway URL
```

A failure anywhere in the indented block is reported to the initiator's user **only** through `State.Error` (the Run page's tab indicator), and — as finding **R-03** shows — that indicator carries no text. Findings **R-01/R-02** are why "dshkerd connects but the desktop does not" is, today, the expected outcome rather than an edge case.

---

## Findings, by severity

### R-01 — The peer workbench URL never reaches the renderer: a `ready` peer tab can never load the remote desktop

**Severity: critical** (product-blocking; every successful connection)

**Symptom.** The Run page's paired-computer tab shows a **ready** state (green status dot, `data-state="ready"`), the connection indicator says connected, and the body still shows the empty state _"Remote DSH is not connected — Go to the remote connections page to establish or retry this computer's SSH tunnel."_ No `<webview>` is ever created for the peer. The desktop never opens, however healthy the P2P session is. There is no error, no refusal code, and no retry that changes it. The same gap is the second entry point: the Run page's add-tab dialog labels the computer with the _stage_ sentence only (`RuntimeTabAddMenu.vue:31-37,52-60`) and then opens the tab, and the Remote tab's "Open workbench" button (`P2PPairingPanel.vue:92-96,227-235`) navigates to Run with a `peer:` tab and no address.

**Evidence.**

- `src/app/shell/runtimeBrowserState.ts:133-147` — `peerTabs()` builds `url: status?.kind === 'ready' ? current?.url : undefined`. `current = navigation[id]`.
- Nothing ever writes `navigation['peer:…']`.
  - The only production writer of `navigation` is `updateTab` (`runtimeBrowserState.ts:188-195`), driven only from `RuntimeTabsPanel.vue:151-156` out of `view.getURL()` — i.e. it records a navigation the guest already performed.
  - `RuntimeTabsPanel.vue:581-595` mounts the `<webview>` only for `tabs.value.filter((entry) => entry.url !== undefined)`. `url` is never set, so the guest never mounts, so `updateTab` can never fire: a closed loop.
  - The remote (SSH) branch does not have this problem because it takes the URL from `remoteConnectionsState` at `runtimeBrowserState.ts:106` (`connection.status.url`). Peer tabs were deliberately stripped of that field and nothing replaced it.
- The main process _does_ hold the entry URL and _does_ expose a resolver: `electron/main/p2p/connections.ts:80-85` (`entry(serviceId, pairId, generation)`), stored at `connections.ts:54`. **`entry()` is called from tests only** — `electron/main/p2p/connections.test.ts:82,84,95,107,120,121,143`.
- There is no IPC operation that could carry it: `electron/preload-surface.golden.json:40-78` lists the whole `p2pManagement` surface (no `entry`/`workbench`/`open` operation), and `electron/main/p2p/management-ipc.ts:74-210` registers every one of them. `projectPeerConnection` (`management-projection.ts:144-162`) is an allow-list that structurally cannot include a URL.
- The commit that introduced peer tabs confirms the intent and the gap: `git show 961f10a -- src/app/shell/runtimeBrowserState.ts` adds `url: ready ? current?.url : undefined` with the comment _"the actual address is supplied to the guest by main"_ — that supplier was never written.
- Docs state the same intent and nothing implements it: `docs/handover-p2p-connection-state.md:62` (_"DSH 入口留在主进程，由主进程直接交给 guest"_), `.agents/notes/2026-09-13-stable-gateway-url.md:10-12` (_"Inside the app that was invisible — main simply handed the new address to the guest view"_).
- The related machinery is likewise dead: `WorkbenchGuests.register()` (`electron/main/workbench-guests.ts:44`) is called only from `workbench-guests.test.ts:31`; `assertPeerPartition` (`electron/main/p2p/partitions.ts:48-56`) only from `partitions.test.ts:40,47`. The renderer never sets a webview `partition` (`grep partition src/` → nothing outside a comment and a code list), so the peer-partition isolation the security policy advertises (`electron/main/security.ts:55-61,84-86`) is not in effect for peer tabs either.
- This is a **known-open work item, not an oversight in the plan**: `openspec/changes/add-self-hosted-p2p-dsh-connections/tasks.md:96` (task 4.3, the URL handoff to the restricted Run guest) is unchecked, and `openspec/changes/go-owned-headless-core/tasks.md:42` records the runtime browser as still shell-owned. The product behaviour described to users is nevertheless already advertised: the pairing row offers an "Open workbench" button (`P2PPairingPanel.vue:227-235`, label `p2p.connect.openWorkbench` = "Open workbench") whose handler (`P2PPairingPanel.vue:92-96`) only opens a `peer:<connectionId>` tab and navigates to Run — it fetches and passes no URL, so it always lands on the empty state. A user who presses "Open workbench" therefore gets nothing but a status tab.
- Note also that the CHANGELOG claim at `CHANGELOG.md:173-176` ("the remote DSH Web page loading through the tunnel") was verified through the `live-drive` tool printing the gateway URL (`networking/tools/live-drive/main.go:391-392,462-498`) and a real browser, **not** through the packaged Run page.

**Refusal code / message:** nothing surfaces. There is no code, because nothing failed.

**Minimal fix.** Add one named main-process operation that hands the _already stored_ entry to the Run page under the same admission rules as everything else, and have the peer branch consume it:

1. `management-ipc.ts`: `register('connections', false, …)` gains nothing; instead add an explicit operation, e.g. `p2pManagement.entry({serviceId, pairId, generation})` → `{ url }`, implemented as `owner.entry(serviceId, pairId, generation)` (which already refuses a wrong generation with `p2p.stale_generation` and a missing one with `p2p.connection_not_found`, `connections.ts:80-85`).
2. `src/app/shell/runtimeBrowserState.ts:143`: `url: status?.kind === 'ready' ? (current?.url ?? peerEntry[id]?.url) : undefined`, where `peerEntry` is filled by that call and cleared in the same watcher that clears `navigation` (`runtimeBrowserState.ts:256`).
3. `RuntimeTabsPanel.vue:586`: also set `:partition="peerPartition(serviceId, pairId)"` for `tab.source === 'peer'`, so the isolation the policy already admits is real.

**Test idea.** `src/app/shell/tests/peerRuntimeTabs.test.ts`: with `p2pConnections.state.peers = [peer({ stage: 'ready' })]` and the new entry result stubbed, assert `peerTab()?.url === <gateway url>` and that `RuntimeTabsPanel` renders `[data-testid="runtime-webview-peer:<connectionId>"]`. A negative case: stage `failed` ⇒ no webview, and the url is dropped. This is the test that would have caught the whole finding.

---

### R-02 — The runtime refusal is destroyed twice: the initiator is told `p2p.runtime_unavailable`, then `p2p.internal_error`

**Severity: high** (the reason a runtime failure is indistinguishable from a transport failure)

**Symptom.** On the machine whose user clicked Run, a failure caused on the _other_ machine (workbench not running, port held, checkout not ready, first start slow) always reads the same: the tab shows a failed/red indicator and the user is told nothing else. On the target machine the refusal is at best a local toast the remote user cannot see.

**Evidence — leg 1, the Go handshake flattens it.**

- The target's owner result is sent, and then immediately thrown away by the initiator: `networking/internal/runtimebridge/handshake.go:84-93` sets `request.Error = "p2p.runtime_unavailable"` and returns `err`; the initiator reads it at `handshake.go:56-62` and collapses _everything_ to `errors.New("p2p.runtime_unavailable")` (`handshake.go:60-62`) — the decoded `hello` is discarded. The same constant is also produced for `incoming.Type != "runtime.connect"` (`handshake.go:69-71`), for a nil owner (`handshake.go:72-74`), and for a `readHello` timeout (`handshake.go:56-58` → `context.DeadlineExceeded` → `manager.go:606` `namedRefusal` → `p2p.runtime_unavailable`, `manager.go:240-251`). The comment at `handshake.go:87-88` ("Never swallow the reason") is defeated one line later at `handshake.go:60`.
- The target's refusal is therefore only visible in `dshkerd`'s own stderr (`handshake.go:89`).

**Evidence — leg 2, the TS layer rejects every runtime code before it can be sent.**

- `electron/main/p2p/runtime-owner.ts:40-49` rejects with the raw `ManagedHarnessRuntimeError` (e.g. `code === 'runtime.port_in_use'`, `runtime.worktree_invalid`, `runtime.child_unavailable`, `runtime.operation_in_progress`).
- `electron/main/p2p/rpc.ts:148-153`: `peerErrorCode(error.code)` _does_ accept `runtime.*` (`electron/main/p2p/wire.ts:102-106`), so the frame does carry `runtime.port_in_use`. The Go side receives it as an error (`networking/internal/helper/host.go:202-212`), `protocol.Refusal` accepts the family (`networking/internal/protocol/refusal.go:24,41-52`), and `namedRefusal` passes it through unchanged (`networking/internal/peeression/manager.go:240-243`). So the code _does_ survive the wire.
- It then dies in the shell that receives it: `electron/main/p2p/management-ipc.ts:223-237` maps any code not present in `P2P_MANAGEMENT_ERROR_CODES` (`src/shared/p2p-management.ts:454-648`) to **`p2p.internal_error`**. That list contains no `runtime.*` and no `managed.*` code at all (`grep 'runtime\.' src/shared/p2p-management.ts` → nothing) — it lists only `p2p.*`.
- So the code the target legitimately reported (`runtime.port_in_use`, `runtime.worktree_invalid`, …) is rendered to the initiator as `p2p.internal_error`, and the structure the whole 3.8 effort was built to protect is lost at the last hop. `P2P_MANAGEMENT_ERROR_CODES` also omits `p2p.runtime_timeout` (`runtime-owner.ts:115-118`) and the two codes `runtime-host.ts` can itself produce: `p2p.runtime_invalidation_failed` (`runtime-host.ts:55`) and `p2p.runtime_owner_closed` (`runtime-owner.ts:32,61`) — neither string exists anywhere under `src/`.
- `runtime-host.ts:140-141` can also refuse the callback outright with `p2p.runtime_request_unscoped` (also the one runtime code that _is_ in the allow-list, `p2p-management.ts:517`).

**Refusal code / message that surfaces to the initiator:** `p2p.runtime_unavailable` (if the failure was raised on the target's Go side) or `p2p.internal_error` (if it came from the target's shell), never the real cause. On the target's own screen a _local_ toast can show the real text via `AppShell.vue:106,119` → `managed.harness_port_in_use` — but only when the failure took the `core.runtime.start` throw path; a launch that returns a `failed` view is rejected as `p2p.runtime_unavailable` with no code at all (`runtime-owner.ts:44-47`).

**Minimal fix.**

1. `handshake.go:60-62`: carry the responder's code instead of the constant — `if response.Error != "" { return … errors.New(response.Error) }` (the value already arrives in the frame and is already validated as a public code by `publicError`, `networking/internal/localrpc/rpc.go:168-177`). Keep `p2p.runtime_unavailable` only for `response.Type != "runtime.result"`.
2. `src/shared/p2p-management.ts`: add the `runtime.*` codes the peer path can return (`runtime.port_in_use`, `runtime.worktree_invalid`, `runtime.child_unavailable`, `runtime.spawn_failed`, `runtime.operation_in_progress`, `runtime.child_crashed`, `runtime.not_found`), plus `p2p.runtime_timeout`, `p2p.runtime_owner_closed`, `p2p.runtime_invalidation_failed`.
3. `AppShell.vue:98-121`: map those codes to copy (the target-side copy is already written for the equivalent `managed.*` codes at `ipc-error-codes.ts:46-68`).

**Test idea.** Go: a `runtimebridge` test that stands a responder up with an owner returning `errors.New("runtime.port_in_use")` over a real mux pair and asserts `Establish` on the initiator returns that exact code (today it would return `p2p.runtime_unavailable`). TS: extend `management-ipc` tests with `error instanceof PeerHelperError && code === 'runtime.port_in_use'` asserting `apiFail('runtime.port_in_use', …)`, not `p2p.internal_error`.

---

### R-03 — No P2P connection failure has any user-visible text on the Run page; transport and runtime failures are literally indistinguishable

**Severity: high** (makes R-01/R-02 invisible to the user and to support)

**Symptom.** Whatever fails — `p2p.direct_unavailable`, `p2p.runtime_unavailable`, `p2p.runtime_websocket_failed`, `p2p.internal_error` — the Run page shows the same thing: a status dot, and the empty state _"Remote DSH is not connected"_ with the description _"Go to the remote connections page to establish or retry this computer's SSH tunnel."_ (both languages: `messages.en-US.ts:737-740`, `messages.zh-CN.ts:661-663`). The text is also wrong for a P2P pair: it tells the user to set up an SSH tunnel.

**Evidence.**

- The code is projected to the renderer (`management-projection.ts:154` `error: state.error`) and kept (`p2pConnections.ts:64-73` → `RuntimeTabStatus.failed.code`, `runtimeBrowserState.ts:56-76`), but the only consumer is the CSS state attribute: `RuntimeTabsPanel.vue:404-406` `:data-state="… tab.status?.kind"`, styled at `RuntimeTabsPanel.vue:744`. There is no `<template>` interpolation of `tab.status.code` anywhere in the file.
- `docs/handover-p2p-connection-state.md:76` already records this as unfinished: _"`failed` 的 `code` 尚无对应文案映射"_.
- `src/app/shared/i18n/i18n.refusals.ts` (a category-keyed refusal dictionary, written for exactly this) has **zero importers** — `grep 'p2p.refusal'` finds only its own definition.
- `AppShell.vue:132-143` only toasts local harness errors (`harness.error`, `pluginCatalog.error`), never P2P connection state.
- The connect action itself shows nothing on failure: `P2PConnectionsDomain.connect` (`p2pConnections.ts:88-94`) only calls `#recordWriteOutcome` when `!result.ok`, and that method (`p2pConnections.ts:111-124`) merely sets `resultUnconfirmed = true` for any non-listed code — which additionally _disables every later write_ for that pair (`#canWrite`, `p2pConnections.ts:103-105`), so the Retry button silently does nothing after a failed attempt.
- The one hint map that was written to explain a peer connect refusal is dead code, so the two sentences that were meant to distinguish the cases can never render: `P2PPairingPanel.vue:38-48` maps `p2p.peer_offline` / `p2p.direct_unavailable` / `p2p.connection_busy` to `p2p.connect.offlineHint` ("The other computer is offline (its app is not running or signed in). Open DSHKer on it first."), `p2p.connect.directHint` ("No usable direct UDP path between the two networks. There is no relay; use the same network or adjust the firewall.") and `p2p.connect.busyHint`, but looks them up at `P2PPairingPanel.vue:44` as `management.operations[`connect:${serviceId}`]` while `p2pManagement.run` scopes that map by the bare `serviceId` (`p2pManagement.ts:115-125,140-142,265-267`). The same off-by-a-prefix lookup exists at `P2PServiceEditorPanel.vue:32` (`updateServiceConfig:${serviceId}`). There is also no hint at all for `p2p.runtime_unavailable`, so even a repaired lookup would leave the runtime case blank.
- The empty state for a peer even renders `P2PRunActions` (`RuntimeTabsPanel.vue:616-632`), whose button text flips from Connect to Retry purely on `stage === 'failed'` (`P2PRunActions.vue:31,57`) — the only failure feedback the user gets.

**Refusal code / message that surfaces:** the code exists in state (`p2p.internal_error`, `p2p.runtime_unavailable`, …) but **nothing surfaces** in the UI. The peer branch also reuses SSH-specific copy ("…retry this computer's SSH tunnel", `messages.en-US.ts:737-740`), which is actively misleading for a P2P pair. A user cannot tell a transport failure from a runtime failure, which was the explicit goal of `networking/internal/peersession/manager.go:234-251` and `integration/failure_codes_test.go` — and it violates the active change's own requirement (`openspec/changes/add-self-hosted-p2p-dsh-connections/specs/direct-peer-dsh-sessions/spec.md:249,258-259`): a remote-DSH-not-ready failure must render as a staged typed error and must not read as a uniform "peer unavailable".

**Minimal fix.** Map `RuntimeTabStatus.failed.code` to the existing category dictionary (`i18n.refusals.ts`, or a small `code → category` function mirroring `p2pManagement.ts:264-268`), render it in the peer empty state (`RuntimeTabsPanel.vue:616-632`) next to `P2PRunActions`, and stop treating a failed write as `resultUnconfirmed` for codes that are known to have had no effect (`p2pConnections.ts:112-122` already has that list — add `p2p.connection_busy`/`p2p.pair_unauthorized`-style pre-effect codes and, more importantly, clear `resultUnconfirmed` on the next successful `read()`; `p2pConnections.ts:56-64` currently never clears it).

**Test idea.** `RuntimeTabsPanel.test.ts`: render a peer tab with `stage: 'failed', error: 'p2p.runtime_websocket_failed'` and assert a visible, translated message containing the category text and a distinct one for `p2p.direct_unavailable`. `p2pConnections.test.ts`: after a failed connect with `p2p.runtime_unavailable`, assert a second `connect()` is still dispatched (today `#canWrite` blocks it).

---

### R-04 — A stopped or crashed workbench is reported as available: the gateway keeps a stale binding, and the check is a self-comparison

**Severity: high** (produces the reported "connects but the desktop does not open, or opens then fails")

**Symptom.** The peer connects, `Probe` fails, and the attempt dies with `p2p.runtime_http_failed` / `p2p.runtime_websocket_failed`; then auto-connect retries on backoff and it may work or fail again. If the target's DSH Web was stopped or crashed after the shell last read its state, this repeats.

**Evidence.**

- `electron/main/p2p/runtime-owner.ts:31-55`: `connect()` returns `{ ...this.#binding }` immediately when a binding is already cached (`runtime-owner.ts:34`). The cache is seeded at construction from `getRuntimeState()` (`runtime-owner.ts:27`) and refreshed only by `onRuntimeState` events (`runtime-owner.ts:28,76-89`).
- Those events come from `LauncherRuntimeFeed`'s poller, which is started only by `LauncherHarnessService.start()` (`launcher-harness-service.ts:795`) and stops itself the moment the subject is absent, `stopped` or `failed` (`launcher-runtime-feed.ts:63-69`). After a crash that the poller catches, `#accept` does retire the binding — but if the crash happens while the shell is not polling (no launch in this shell, app restarted with a live child, poller already stopped), `#launchState` stays `{kind:'running'}` and the owner keeps serving that URL.
- The later recheck does not catch it: `assertCurrent` (`runtime-owner.ts:66-74`) compares the binding _to itself_ (`this.#binding.generation !== binding.generation || this.#binding.url !== binding.url`) — it detects retirement, never death. `runtime-host.ts:143-148` therefore returns a binding to the peer for a runtime that no longer exists.
- The failure then lands on the initiator's `Probe` (`handshake.go:157-188`) as `p2p.runtime_http_failed` (`handshake.go:176,180`) or `p2p.runtime_websocket_failed` (`handshake.go:185`), and `manager.run` marks the attempt failed (`manager.go:599-608`).
- The same staleness affects the hard 70 s window: `PeerRuntimeOwner.#wait` rejects with `p2p.runtime_timeout` after 70 s (`runtime-owner.ts:115-118`) while the Go budget is also 70 s (`handshake.go:48`), so a genuinely slow first start (a `pnpm`/build cold start) is reported as a timeout, and the pairing then succeeds on the auto-connect retry (`auto-connect.ts:24,151-161`) — a failure the user sees for no reason.
- Note also there is **no Go-side readiness timeout at all**: `harnessruntime` has only `ShutdownTimeout = 5s`; `runtime.ready_timeout`/`runtime.handshake_timeout` exist only as shell-side codes (`electron/main/managed/runtime-errors.ts:12-13`) that the core never throws. A child that never announces stays `starting` forever, and the peer's wait is bounded only by the 70 s owner timeout.

**Refusal code that surfaces:** `p2p.runtime_timeout` (→ `p2p.internal_error` per R-02) or `p2p.runtime_http_failed` / `p2p.runtime_websocket_failed` (→ `p2p.internal_error` likewise). Nothing tells the user "the other machine's workbench is not running".

**Minimal fix.** Make the owner verify liveness at request time instead of trusting the cache: in `runtime-owner.ts:36`, when the cached state is `running` but the feed is not polling, call `source.getRuntimeState()` again (cheap) or, better, expose the existing `LauncherRuntimeFeed.drain`/`status` read and re-read `runtime.status` once before answering. Independently, `runtime-host.ts` should treat `p2p.runtime_timeout` as a _retryable, self-healing_ outcome (it is not in `TERMINAL_CODES`, `auto-connect.ts:31-40` — so this part is already right) and the copy should say so.

**Test idea.** `runtime-owner.test.ts`: seed a `running` state, then emit nothing while the underlying service reports `failed`/`stopped` on a direct `getRuntimeState()` read; assert `connect()` rejects with `p2p.runtime_unavailable` rather than resolving a stale binding. Go: an `Establish` test where the responder's binding URL is closed before the hello → assert `p2p.runtime_websocket_failed` on the initiator and that the returned code is not flattened.

---

### R-05 — A failed first `Establish` leaks a loopback listener and its port for the manager's lifetime

**Severity: medium** (resource leak; can wedge a fixed-port DSH Web)

**Symptom.** No direct user symptom until the process has failed several first-time establishes, at which point several orphan `127.0.0.1:<port>` listeners are held by `dshkerd`. They are invisible to the user and to the Run page.

**Evidence.**

- `peeression/manager.go:562-571`: `Establish` returns `(gateway, endpoint, mux, binding, err)`. On `err != nil` the manager records nothing (`manager.go:563-570`), and the deferred detach at `manager.go:534-539` reads `connection.endpoint`, which is only assigned on success (`manager.go:564-566`) — so the returned endpoint/gateway are unreachable.
- `handshake.go:109-125`: when `attachment == nil`, `NewEndpoint` then `OpenBrowserEndpoint` have already created the listener and the `http.Server` (`proxy.go:71` `net.Listen`, `proxy.go:111` `serve`) before any later step can fail. The two failure points after that are `handshake.go:117-125` (gateway construction) and any failure **after** the `else` branch — there is none — but note that when `attachment == nil` and `OpenBrowserEndpoint` fails, `attachment.Close()` (`handshake.go:122`) does reach `gateway` only through `attachment.onClose`, which is assigned at `proxy.go:120` _after_ `serve` returns; a failure between `serve` and that assignment leaves the listener with no closer.
- Empirically the listener is bound and serving: `endpoint_test.go:275-334` proves the port survives session-context cancel, and the serv-ing goroutine exits only via `proxy.go:250` (`<-ctx.Done(); gateway.Close()`) where `ctx` is `gatewayCtx` = `manager.ctx` (`manager.go:562`). So the leak is bounded by the manager's lifetime — but the port is held for it.
- `NewMux`'s receive goroutine is _not_ leaked (it exits on `transport.Done()`, `peer/streams.go:150-159`), so this is a listener/port leak, not a goroutine one.

**Refusal code:** nothing surfaces; the failed attempt reports the underlying code normally.

**Minimal fix.** In `handshake.go`, close what was just created when a later step fails, and assign the closers before serving. Concretely: move `attachment.onClose = func() { gateway.Close() }` to immediately after `serve` returns (already the case) and add an explicit `gateway.Close()` on the `NewEndpoint` error path; or, simpler and local to the caller, have `manager.run` react to a non-nil endpoint with a non-nil error by calling `endpoint.Close()` (it already has both values in scope at `manager.go:562`).

**Test idea.** `runtimebridge`: construct a mux pair whose `Replace`/handshake fails after the browser gateway exists, then assert `net.Listen` on the same random port succeeds after the call returns (or assert `Endpoint.Done()` closes). A leak-detecting variant: count bound loopback listeners before/after N failed establishes.

---

### R-06 — A late `Detach` from the previous session can tear down the mux the new session just installed

**Severity: medium** (transient 502s exactly at reconnect; depends on timing)

**Symptom.** On a reconnect, the fresh session reports `ready`, but the tab's requests return 502 (`p2p.stream_failed`) until the next reconnect, because the endpoint's mux was nulled after replacement.

**Evidence.**

- `peeression/manager.go:534-539`: every session's defer calls `endpoint.Detach()`, where `endpoint` is whichever endpoint the session recorded — for a reconnect that is the **shared** endpoint object from `manager.endpoints` (`manager.go:555-557, 568`).
- `runtimebridge/endpoint.go:83-94`: `Detach` unconditionally sets `endpoint.mux = nil`; it does not check whether the mux it is dropping is still the current one.
- Ordering: the old session is removed from `manager.sessions` in the same defer that detaches (`manager.go:540` → `finish`, `manager.go:253-261`), so a new `Connect` may be dispatched as soon as `finish` has run, while the old `run` goroutine has one more statement (`manager.finish`) — and, more importantly, the old `Establish` may already have completed and stored a _newer_ mux on the same endpoint. The `<-renewed` wait at `manager.go:523` occurs before the detach (`manager.go:517,523`), which lengthens the window.
- Consequence is visible through the proxy: with `mux == nil`, `endpoint.open()` returns `p2p.reconnecting` (`endpoint.go:144-148`) and the gateway's `ErrorHandler` turns it into 502 `p2p.stream_failed` (`proxy.go:179-181`).
- `TestEndpointOutlivesItsSession` (`endpoint_lifetime_test.go:15-50`) asserts only that the endpoint object is **kept**, never that a late detach is harmless — so this is not covered.

**Refusal code:** none (an HTTP status, not a refusal): 502 with the body `p2p.stream_failed`.

**Minimal fix.** Make `Detach` conditional on the mux it is dropping, e.g. add `DetachIf(mux *peer.Mux)` (or pass the session's mux) in `endpoint.go:83-94` and call it from `manager.go:537-539`; a detach whose mux is no longer current becomes a no-op.

**Test idea.** `endpoint_test.go`: `NewEndpoint(muxA)`, `Replace(muxB)`, then call a detach carrying `muxA`; assert `endpoint.currentMux()` is still `muxB` and a proxied request returns 200.

---

### R-07 — Stopping the workbench from the peer side is a silent auto-restart loop, not an explained state

**Severity: low-medium** (surprising behaviour; the peer cannot tell stop from failure)

**Symptom.** The target's user stops DSH Web. The peer's tab goes to 502, then the connection is retried and **DSH Web starts again on the target machine** without the target's user asking, because `peer.connect` → owner → `source.start()` (`runtime-owner.ts:36-52`) is the same call the Launcher's own Start button uses (`launcher-harness-service.ts:729-797`). If it cannot start, the initiator sees `p2p.runtime_unavailable`/`p2p.internal_error` (R-02) and the target sees a local toast.

**Evidence.**

- `runtime-owner.ts:36-52` — the owner starts the local runtime on demand, with no notion of "the user deliberately stopped it".
- `runtime-host.ts:169-189` — on retirement (`#retire`, `runtime-owner.ts:91-95`) the shell sends `runtime.invalidate`; `helper/host.go:252-261` → `manager.InvalidateRuntime` (`manager.go:278-292`) cancels sessions whose `result.State.RuntimeGeneration` matches _or is still 0_ (`manager.go:286`), i.e. precisely the in-flight ones. That part is correct and is tested (`lifecycle_test.go:116-137`).
- The stop path itself is `launcher-harness-service.ts:903-912`; nothing tells the peer _why_ the runtime is gone (the only peer-visible signal is `p2p.runtime_unavailable`, `core/runtimebinding.go:11-14`).
- `auto-connect.ts:24` retries forever with a widening delay (1 s → 60 s), including after a deliberate stop.

**Refusal code:** `p2p.runtime_unavailable` → `p2p.internal_error` (R-02). The target's own toast for a _failed_ restart maps correctly (`ipc-error-codes.ts:51` → `managed.harness_port_in_use`, shown by `AppShell.vue:106`).

**Minimal fix.** Do not auto-start a runtime that a _peer_ requested while the local launch state is `stopped` because the user stopped it: distinguish "never started" from "explicitly stopped" in `LauncherHarnessService` (it already has both `stopped` and a `#launch` history) and have `PeerRuntimeOwner.connect` refuse with `p2p.runtime_unavailable` (a named, explained refusal) instead of starting. Anything more is a product decision; the minimal honest change is to make it explainable.

**Test idea.** `runtime-owner.test.ts`: state `stopped` after a stop event ⇒ `connect()` must reject without calling `source.start()`; state `stopped` with no prior stop ⇒ `source.start()` is called once.

---

### R-08 — Post-ready reconnect can never reinstate the same session; the workbench is reachable only after a fresh attempt

**Severity: low** (by design, but undocumented in the UI and relevant to "opens then fails")

**Symptom.** The workbench loads, then the transport blips. The tab shows 502s. Auto-connect (`management.ts:86-88` → `auto-connect.ts:87,127-133`) starts a new attempt, which is what actually restores service. The endpoint survives by design (`endpoint.go:55-78`, `proxy.go:56-61`), and the URL never changes (`integration/reconnect_stability_test.go:169-187`), so no user action is required — but nothing in the UI says "reconnecting"; the tab's state is `connecting` only because a new attempt was dispatched.

**Evidence.** `manager.go:529-539` (endpoint intentionally not closed), `endpoint.go:144-148` (`p2p.reconnecting` while detached), `proxy.go:179-181` (502 `p2p.stream_failed`), `endpoint_test.go:71-87` (proves the 502 is deliberate and that recovery follows only on `Replace`), `reconnect_stability_test.go:144-187` (proves the address is stable and no resources leak across 20 cycles).

**Refusal code:** HTTP 502 with body `p2p.stream_failed`. The tab's own recovery depends on the remote DSH Web client retrying its own websocket after the tunnel's sockets are force-closed (`proxy.go:298-309` `DropConnections`), which this audit cannot verify from this repository.

**Minimal fix.** None needed for correctness. If the 502 body must be actionable, keep it, but surface "reconnecting" in the peer tab's copy once R-03 exists.

**Test idea.** Extend `reconnect_stability_test.go` to issue a request through the gateway _during_ the gap and assert 502, then assert 200 on the same URL after the next `Connect` — the endpoint-level version exists (`endpoint_test.go:71-103`); the manager-level one (with auto-connect) does not.

---

### R-09 — The one intended "why did this fail" hint is dead code, and the host-failure path overwrites an honest remote code with a local one

**Severity: low-medium** (two small, independent erasures of the same information R-02/R-03 lose)

**Symptom (a).** The intended explanation for a refused connect — "The other computer is offline…", "No usable direct UDP path…", "A connection operation is already in progress…" — never appears, because the lookup key is wrong.

**Evidence (a).** `P2PPairingPanel.vue:38-48` maps `p2p.peer_offline` / `p2p.direct_unavailable` / `p2p.connection_busy` to `p2p.connect.offlineHint` / `directHint` / `busyHint` (`messages.en-US.ts:194-198`), then reads `management.operations[`connect:${serviceId}`]?.error` at `P2PPairingPanel.vue:44`; `p2pManagement.run` scopes that map by the bare `serviceId` (`p2pManagement.ts:115-125,140-142,265-267`). A repo-wide grep for the `` `connect: `` prefix finds only that one line. The same off-by-a-prefix lookup is at `P2PServiceEditorPanel.vue:32` (`updateServiceConfig:${serviceId}`). There is no hint entry for `p2p.runtime_unavailable` at all.

**Symptom (b).** A local core/helper channel death, or a failed `runtime.invalidate`, rewrites the error of _every_ pair — including one whose real error was the remote runtime — so the last honest information is destroyed.

**Evidence (b).** `runtime-host.ts:191-200` (`#unavailable`) sets `value.state = { ...value.state, stage: 'failed', error: this.#failure.code }` for every tracked peer, where `#failure` is the channel or invalidation error (`runtime-host.ts:53-57,84-92`). `#failure.code` is not screened by `P2P_MANAGEMENT_ERROR_CODES`, so codes like `p2p.runtime_invalidation_failed` and `p2p.gateway_closed` reach `peer.error` (`management-projection.ts:154`) — and are then rejected by the operation allow-list everywhere else (`management-ipc.ts:223-237`). Only the Remote tab ever shows it raw (`P2PPairingPanel.vue:122-124`, `p2p.connection.helperError` + `<code>`); the Run page shows nothing.

**Refusal code:** `p2p.runtime_invalidation_failed` (no message anywhere) or whatever local code replaced the remote one; **nothing surfaces** on the Run page.

**Minimal fix.** (a) Read the operation by `serviceId` at both sites, narrowed with `.method === 'connect'` / `'updateServiceConfig'` as `P2PEnrollmentPanel.vue:15-21` and `P2PManagementPanel.vue:48-53` already do, and add a `p2p.runtime_unavailable` hint. (b) Keep the first honest error: in `#unavailable`, do not overwrite a peer's `error` when it already records a `starting-runtime`/`runtime_*` failure, or record the host failure separately (the snapshot already has a top-level `error` field, `runtime-host.ts:99-107`).

**Test idea.** `P2PManagementPanel`/`P2PPairingPanel` test: run a failing `connect` and assert the `p2p-connect-hint` element renders the expected hint text. `runtime-host.test.ts`: emit a peer `failed` with `p2p.runtime_unavailable`, then trigger a channel death, and assert the peer's projected `error` is still the remote code while `snapshot().error` carries the local one.

---

## What each layer can and cannot see

| Failure                                           | Where produced                                                                                                    | Initiator's shell sees                                                                                | Target's shell sees                                                | User text today                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| No direct path / relay failed                     | `manager.go:543-548` → `namedRefusal` `manager.go:240-249`                                                        | **`p2p.direct_unavailable`**                                                                          | `failed` state on its own side                                     | nothing (R-03)                                |
| Transport died mid-handshake                      | `handshake.go:140-152`                                                                                            | `p2p.direct_closed` / `protocol_mismatch`                                                             | same                                                               | nothing                                       |
| Handshake timeout (70 s)                          | `handshake.go:48,56-58`                                                                                           | **`p2p.runtime_unavailable`**                                                                         | none                                                               | nothing                                       |
| Target's workbench not running                    | `handshake.go:60-62` ← `runtime-owner.ts:44-47` / `core/runtimebinding.go:11-14`                                  | **`p2p.runtime_unavailable`**                                                                         | local toast only if it threw                                       | nothing                                       |
| Target's start refused (port, checkout, spawn)    | `handshake.go:60-62` ← `runtime-owner.ts:48` ← `launcher-harness-service.ts:729-797` / `ipc-error-codes.ts:46-68` | **`p2p.runtime_unavailable`**                                                                         | `managed.harness_port_in_use` toast (`AppShell.vue:106`)           | nothing on the initiator                      |
| Target shell returned a bad shape                 | `handshake.go:102-104` / `helper/host.go:207-211`                                                                 | `p2p.runtime_invalid` / `p2p.internal_error`                                                          | `[p2p] internal_error` in main's console (`management-ipc.ts:233`) | nothing                                       |
| Callback arrived with no `starting-runtime` stage | `runtime-host.ts:139-141`                                                                                         | `p2p.runtime_request_unscoped` → `p2p.internal_error`                                                 | same                                                               | nothing                                       |
| Binding retired mid-callback                      | `runtime-owner.ts:66-74`, `runtime-host.ts:146`                                                                   | `p2p.runtime_invalidated` → `p2p.internal_error`                                                      | same                                                               | nothing                                       |
| Runtime stopped under an attached peer            | `manager.go:278-292` (invalidate) + `runtime-owner.ts:91-95`                                                      | `disconnected`, then a new attempt                                                                    | local state change                                                 | nothing                                       |
| `runtime.invalidate` call failed                  | `runtime-host.ts:53-57,191-200`                                                                                   | **every** peer forced to `failed`, `p2p.runtime_invalidation_failed`, host latched (no later `start`) | same                                                               | nothing (code is not in any allow-list, R-02) |
| Probe failed (no cookie / no `/api/remote.mux`)   | `handshake.go:176-187`                                                                                            | `p2p.runtime_http_failed` / `p2p.runtime_websocket_failed` → `p2p.internal_error`                     | none                                                               | nothing                                       |
| Request while detached                            | `endpoint.go:144-148` → `proxy.go:179-181`                                                                        | HTTP **502**, body `p2p.stream_failed` (browser tab)                                                  | n/a                                                                | the tab's own error page                      |
| `ready` but no tab URL                            | `runtimeBrowserState.ts:143`                                                                                      | — (no failure at all)                                                                                 | —                                                                  | the peer empty state, even on success (R-01)  |

Everything in the "sees" columns beyond `p2p.*` is destroyed by `management-ipc.ts:223-237` before the renderer.

---

## What the existing tests prove, and what they do not

**Proven (green locally: `go test ./internal/runtimebridge/ ./internal/peersession/` → ok).**

- `endpoint_test.go:24-107` — the browser gateway keeps its URL across a detach/replace, and a request during the gap returns 502.
- `endpoint_test.go:111-125` — a closed endpoint refuses later sessions.
- `endpoint_test.go:212-270` — a detached gateway reaches no runtime content.
- `endpoint_test.go:275-334` — the port survives a session-context cancel, and only the gateway's own context releases it.
- `endpoint_test.go:340-374` — the reported URL is this machine's gateway, not the peer's loopback.
- `endpoint_lifetime_test.go:15-50` / `55-84` — a session ending keeps the endpoint; revocation closes it.
- `integration/reconnect_stability_test.go:94-197` — 20 reconnect cycles, one address, both role assignments, no goroutine growth.
- `integration/runtime_session_test.go:25-110` — a real DSH process, five reconnects, a real restart changing generation 1→2, probes of the gateway, and `assertGatewayDetached`/`assertGatewayClosed`.
- `peersession/lifecycle_test.go:86-137` — a late owner binding is refused with `p2p.runtime_invalidated`; invalidation stays scoped to the local runtime.
- `integration/failure_codes_test.go:20-93` — authorization / availability / presence are three distinct codes end to end.

**Not proven (each maps to a finding above).**

1. **No `handshake_test.go` exists at all.** Nothing exercises `Establish`'s owner-refusal path, the wrong-`Type` path, the mismatched `AttemptID`/`Generation` path, a responder whose `binding.Endpoint()` is invalid, or the 70 s timeout. R-02's flattening is therefore completely untested — and so is its fix.
2. No test asserts what happens to an **endpoint/port created by a failed `Establish`** (R-05).
3. No test exercises a **`Detach` that arrives after a `Replace`** (R-06).
4. `runtime-host.test.ts` covers the callback gates well (lines 138-221) but never asserts that a returned code survives to the renderer; `management-ipc.test.ts` never uses a `runtime.*` code.
5. `src/app/shell/runtimeBrowserState.test.ts` covers only local and remote tabs (lines 70-164) — **no peer-tab case at all**, which is exactly why R-01 survived (`peerRuntimeTabs.test.ts:87-89` asserts the URL is _undefined_ when not connected, and never asserts it is present when ready; line 100-103 only asserts that a ready tab carries no address, which R-01 satisfies vacuously). The unimplemented handoff is tracked as an unchecked OpenSpec task (`openspec/changes/add-self-hosted-p2p-dsh-connections/tasks.md:96`), so no release gate is failing on it.
6. No test starts a peer against a target whose runtime is genuinely absent, so `p2p.runtime_unavailable` is never distinguished from a transport failure at the UI level.
7. No test exercises the operation-scope key used by the connect hint, which is why R-09(a) never failed a gate.

---

## Highest-value three fixes (runtime stage specifically)

1. **Give the peer tab its URL (R-01).** One main-process operation returning the already-stored entry under generation admission (`connections.ts:80-85`), consumed at `runtimeBrowserState.ts:143`, plus the webview `partition`. This is OpenSpec task 4.3 and it is the product's only missing piece for the runtime stage: without it, the transport can be perfect and the desktop still never opens. Test: a ready peer tab renders a `<webview>`.
2. **Stop destroying the runtime refusal (R-02).** Two mechanical changes — `handshake.go:60-62` returns the responder's real code instead of `p2p.runtime_unavailable`, and `P2P_MANAGEMENT_ERROR_CODES` (`src/shared/p2p-management.ts:454-648`) admits the `runtime.*` family plus `p2p.runtime_timeout`/`p2p.runtime_owner_closed`/`p2p.runtime_invalidation_failed`/`p2p.gateway_closed`. This is what makes "the peer's workbench is not running" distinguishable from "the network is down", which is the stated purpose of the failure-code work.
3. **Show the code, and make the workbench-liveness check real (R-03 + R-04).** Render `RuntimeTabStatus.failed.code` through the existing category dictionary (`i18n.refusals.ts`, currently imported by nothing outside the account panel), fix the SSH-specific copy at `messages.*.ts:737-740` for peer tabs (`RuntimeTabsPanel.vue:616-632`), repair the two dead `connect:`/`updateServiceConfig:` operation lookups (`P2PPairingPanel.vue:44`, `P2PServiceEditorPanel.vue:32`), and make `PeerRuntimeOwner.connect` re-read the runtime state before answering with a cached binding (`runtime-owner.ts:34-36`). With 1 and 2 in place, these turn the remaining failures into something a user (and a support ticket) can act on.
