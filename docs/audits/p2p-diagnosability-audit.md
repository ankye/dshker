# DSHKer Launcher — P2P pairing/connection diagnosability audit

Scope: read-only investigation of the DSHKer Launcher app repository.
No file was modified. Every claim below cites a path and line number.

Conclusion in one line: the app already knows every fact needed to explain a P2P
failure, holds all of it in memory for the lifetime of one attempt, and discards
all of it on failure — the packaged app has no P2P evidence of any kind on disk,
and the renderer is handed a stage enum whose `error` field it never reads.

---

## (a) What exists today

### A1. The core child process: spawn, streams, and what is written

`CoreSupervisor` is the only spawner of `dshkerd`:

- Spawn: `electron/main/core/supervisor.ts:124-128` — `spawn(executable, coreArguments(options), { stdio: 'pipe', windowsHide: true, env: { ...process.env } })`.
  `coreArguments` (`:12-16`) passes only `--data <dataRoot>` and optionally `--catalog <catalogRoot>`.
  The spawned env is the inherited parent env verbatim; the app itself never sets
  `PION_LOG_*`, `DSH_P2P_TRACE`, or any pion logging variable (grep for
  `PION_LOG|SetLoggerFactory` over `networking/` returns no production match).
- stdin: the one-shot bootstrap record, `child.stdin.end(JSON.stringify({ version: 1, socket: socketPath, secret }))`
  at `:167`. The secret is per-launch and in-memory only.
- stdout: tapped for the first 512 bytes (`tap`, `:141-148`) so a failed handshake can
  be quoted verbatim; after the announcement is consumed the tap is removed (`:180`) and
  stdout is re-attached purely as console noise (`:214-216`).
- **stderr — this is the decisive line** (`:159-161`):
  ```ts
  if (process.env.DSH_P2P_TRACE === '1')
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  else child.stderr.resume()
  ```
  `child.stderr.resume()` drains and discards. That is exactly why tonight's outage
  needed `DSH_P2P_TRACE=1`: the Go core's per-method refusal lines
  (`peer.connect: p2p.direct_unavailable`, `start <pairID>: <err>`) are written to
  `os.Stderr` (`networking/internal/peersession/manager.go:469`,
  `networking/internal/runtimebridge/handshake.go:89`) and land nowhere else.
- stdout/stderr after the handshake follow the same rule (`:214-216`), again gated on
  `DSH_P2P_TRACE`.

**In the packaged app these streams go nowhere.** `stdio: 'pipe'` means the bytes
reach the Electron main process; `child.stderr.resume()` drops them, and the
`DSH_P2P_TRACE` branch writes to `process.stderr`, which for a packaged Windows
app launched from Explorer/Start is not attached to a console or a file. No
rotation, no file, no ring buffer.

### A2. What is persisted, and where

The two roots that matter:

| Root             | Value                                                               | Line                       |
| ---------------- | ------------------------------------------------------------------- | -------------------------- |
| Launcher root    | `path.join(homedir(), '.dshlauncher')`                              | `electron/main.ts:123`     |
| Core `--data`    | `path.join(launcherRoot, 'core-data')` → `~/.dshlauncher/core-data` | `electron/main.ts:293`     |
| Core `--catalog` | `path.join(settingsRoot, 'dsh-launcher')`                           | `electron/main.ts:294-295` |

1. **`core-diagnostics.log` — the core-channel mechanism.** `electron/main/core/supervisor.ts:133-140`:
   ```ts
   const diagnose = (message: string): void => {
     void appendFile(
       join(options.dataRoot, 'core-diagnostics.log'),
       `${new Date().toISOString()} ${message}\n`,
       'utf8'
     ).catch(() => undefined)
   }
   ```
   It is called at `:151` (child close, with exit code, signal and the captured
   announcement bytes), `:157` (spawn error), `:174` (handshake failed, raw bytes),
   `:182`, `:187`, `:221`, `:229` (version probe/reject), and `:232` (`ready core.version=…`).
   **This is the only P2P-adjacent artifact that survives in the packaged app, and it
   only ever describes the core _handshake_.** It records nothing about `peer.connect`,
   no stage transitions, no refusals from the peer state machine, and no timestamps
   other than the write time. Nothing in the test suite reads it back (grep for
   `core-diagnostics` matches only `supervisor.ts:136` and `CHANGELOG.md:35`).
2. **`shell-diagnostics.log` — the shell's own mechanism.** `electron/main/p2p/management.ts:283-292`
   appends to `join(root, 'dsh-launcher', 'shell-diagnostics.log')` under the settings root
   (i.e. inside `--catalog`). It is reached only from `#refusalCode` (`:277-281`):
   ```ts
   #refusalCode(error: unknown): string {
     if (error instanceof PeerHelperError) return error.code   // <-- typed refusals return here
     void this.#diagnose(error)                                 // <-- only UNTYPED failures are logged
     return 'p2p.internal_error'
   }
   ```
   So a `p2p.direct_unavailable` — a _typed_ refusal, i.e. exactly tonight's failure —
   is **not** written to this file. It records only the exceptions the shell could not
   classify (the CHANGELOG entry at `CHANGELOG.md:26-30`).
3. **The launch log.** `~/.dshlauncher/logs/dsh-web.log` (`electron/main.ts:235`, written by
   the core; see `electron/main/managed/launcher-harness-service.ts:884` and the OpenSpec note
   in `openspec/changes/go-owned-headless-core/tasks.md:74`). This is the DSH Web child's
   stdout/stderr — a _different_ process from `dshkerd`. It is the file the user docs
   point at (`docs/usage.en.md:44`, `docs/usage.zh-CN.md:44`) and is reachable from the
   Controller console (`src/app/shell/components/ControllerPanel.vue:176`, `:248-254`).
   It cannot contain P2P peer negotiation, which happens in `dshkerd`.
4. **Memory-only state.** `PeerRuntimeHost.#states` (`electron/main/p2p/runtime-host.ts:46`)
   is the live stage map: `Map<"serviceId:pairId", { serviceId, state: PeerHelperState }>`
   — one entry per pair, overwritten in place at `:135`. `PeerManagement.#sessions`
   (`electron/main/p2p/management.ts:64`) holds one online/offline + code per service.
   `P2PWorkReconciliationDomain.#records` (`src/app/domains/remote-connections/p2pWorkReconciliation.ts:39`)
   is the only attempt-keyed record anywhere and it is renderer reactive state, erased on reload.

Net: **a user or support engineer on a machine they cannot attach a debugger to has
exactly one readable artifact — `~/.dshlauncher/core-data/core-diagnostics.log` — and it
says nothing about pairing or connection.**

### A3. The stage/error model and what it carries

`PeerHelperState` (`electron/main/p2p/helper-state.ts:4-12`) already carries the right
identifiers and is strictly validated (`:15-54`), including the invariant that a
`failed` stage must carry a non-empty code (`:51-52`) and that `ready` requires a real
direct path (`:46-50`):

```ts
pairId, attemptId, generation, stage: 'punching'|'starting-runtime'|'ready'|'failed'|'disconnected',
error: string, path: { localType, remoteType, protocol }, runtimeGeneration
```

`attemptId` and `generation` are generated by the _core_ and travel on the wire
(`networking/internal/protocol/signal.go:40` `PairID`, `:83` `AttemptID`), so
`pairId` + `attemptId` already correlate both machines. The projection to the renderer
(`src/shared/p2p-management.ts:277-288`) preserves all of it.

The ingestion path is the only place that sees it in main: `PeerRuntimeHost.#handle`
(`runtime-host.ts:119-149`), which stamps `#states` at `:135` and fires the
fire-and-forget `onPeerStage` hook at `:136`. The sole consumer is
`PeerManagement`'s constructor callback (`management.ts:86-88`), which uses it to
trigger a reconnect and **drops the stage string and the attempt identity on the floor**:

```ts
onPeerStage: (_serviceId, _pairId, stage) => {
  if (stage === 'disconnected' || stage === 'failed') void this.#autoConnect.reconcile()
}
```

### A4. The refusal path, end to end

1. **Go.** An attempt fails; the core computes a named refusal and reports it two ways:
   as the RPC answer to `peer.connect` and/or in a `peer.state` callback
   (`networking/internal/peersession/manager.go:248` returns `p2p.direct_unavailable`;
   `networking/internal/peer/transport.go:107,197,252,304`; `negotiation.go:147`).
   The wrapping/classification rule is `networking/internal/protocol/refusal.go` ✓.
2. **Channel.** `PeerRpc` returns either the refusal to the caller or hands the
   `peer.state` payload to the dispatcher registered by `CoreSupervisor`
   (`electron/main/core/supervisor.ts:195-205`).
3. **Main.** `PeerRuntimeHost.#handle` validates via `parseHelperState`, stores it,
   calls `onPeerStage` (A3). On a channel-level death, `#unavailable` (`:191-200`)
   rewrites **every** stored state to `stage:'failed'` with the channel code — a
   blanket overwrite that destroys the per-pair distinction.
4. **IPC.** `management-ipc.ts:175` projects `owner.connections()` to the renderer;
   `:187-188` projects a `connect` answer. Any failure is normalized by `failure()`
   (`:223-236`) to a bare code, and anything unrecognized becomes `p2p.internal_error`.
5. **Renderer store.** `P2PConnectionsDomain` (`src/app/domains/remote-connections/p2pConnections.ts`)
   holds `peers: P2PConnectionView[]`, `helperError`, `resultUnconfirmed` (`:8-13`).
   `read()` (`:56-64`) replaces `peers` wholesale and stops polling once nothing is
   in flight (`:39-49`). `find()` (`:67-69`) returns the current view only.
6. **Copy.** `runtimeBrowserState.peerTabStatus` (`src/app/shell/runtimeBrowserState.ts:56-76`)
   reduces the view to `{kind:'failed', code: peer.error}` for a tab.
   `P2PPairingPanel.vue:167-181` renders the stage label only:
   `t(stageLabels[connections.find(...)!.stage])` with
   `stageLabels.failed = 'p2p.connection.stageFailed'` (`:56-62`).
   `p2p.connection.stageFailed` = "连接失败" / "Connection failed"
   (`messages.zh-CN.ts:90`, `messages.en-US.ts:107`).

### A5. What the user can actually act on

There is exactly one affordance that inspects a code, and it is keyed off the
**synchronous operation** outcome, not the peer state:

- `P2PPairingPanel.vue:38-48` maps three codes from
  `management.operations['connect:' + serviceId]?.error` to friendly copy:
  `p2p.peer_offline` → `p2p.connect.offlineHint`, `p2p.direct_unavailable` → `p2p.connect.directHint`,
  `p2p.connection_busy` → `p2p.connect.busyHint`; rendered at `:223-225`.
- That store entry is only `phase:'failed'` when the `connect` **IPC call itself**
  rejects (`p2pManagement.ts:140-142`). When `peer.connect` is _accepted_ and the
  attempt later fails asynchronously — the ordinary case, and the one that produced
  tonight's outage — `p2pConnections.connect` sees `result.ok === true`
  (`p2pConnections.ts:90-93`), so the operation is marked succeeded and no hint
  ever appears.
- The trailing code is never rendered — only the stage is. `P2PConnectionView.error`
  reaches `RuntimeTabStatus.failed.code` (`runtimeBrowserState.ts:72`), and the two
  consumers of that status both use the _kind_ only: `RuntimeTabsPanel.vue:405-411` binds
  it to `data-state` on an `aria-hidden` dot with no text, and `RuntimeTabAddMenu.vue:52-60`
  renders the stage label (`peerStageLabels.failed` → `p2p.connection.stageFailed`, `:31-37`,
  shown as `<small>{{ option.statusLabel }}</small>` at `:306`). `P2PRunActions.vue:27-31`
  reads `stage === 'failed'` solely to relabel the button "retry" (`:57`). In every case
  `error` is available and discarded.

The contrast that proves the omission is deliberate-but-unfinished: the _SSH_ panel
does render label **and** code — `RemoteSSHManagementPanel.vue:123-125` shows
`{{ errorLabel(connection.status.code) }} · {{ connection.status.code }}`.

---

## (b) Concrete gaps

Severity: **S1** = the failure cannot be diagnosed at all after the fact; **S2** = the
user is given nothing actionable; **S3** = friction/cost, diagnosable with effort.

| #   | Gap                                                                                                                               | Sev    | User-visible consequence                                                                                             | Evidence                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| G1  | The core's stderr is drained and discarded unless an undocumented env var is set before launch; nothing is persisted in its place | **S1** | A P2P outage leaves zero evidence on the machine, so support can only say "reproduce it with `DSH_P2P_TRACE=1`"      | `supervisor.ts:159-161`, `:214-216`; `manager.go:469`                                                 |
| G2  | Every load-bearing P2P fact is memory-only: stage map, session map, the work-reconciliation record                                | **S1** | Restarting the app — the first thing a user does — erases the failure, including whether a connection ever succeeded | `runtime-host.ts:46`; `management.ts:64`; `p2pWorkReconciliation.ts:39`                               |
| G3  | `core-diagnostics.log` covers only the core handshake, and `shell-diagnostics.log` deliberately skips typed refusals              | **S1** | The one file support can ask for is guaranteed not to contain the connection failure                                 | `supervisor.ts:134-140`; `management.ts:277-281`                                                      |
| G4  | An asynchronous stage failure never becomes an actionable message; the stage renders as a bare "Connection failed"                | **S1** | The user sees "连接失败" with no cause and no next step, while the app holds `p2p.direct_unavailable` in memory      | `P2PPairingPanel.vue:167-181`, `:38-48`; `p2pConnections.ts:90-93`                                    |
| G5  | The peer error code is dropped at the tab layer and never rendered, although the SSH surface renders its equivalent               | **S2** | Two paired computers fail for different reasons and look identical on the Run page                                   | `runtimeBrowserState.ts:72`; `RuntimeTabsPanel.vue:405-411` vs `RemoteSSHManagementPanel.vue:123-125` |
| G6  | `#unavailable` overwrites every pair's state with one channel code                                                                | **S2** | After a channel drop, the UI asserts all pairs failed for the same reason, which may be false                        | `runtime-host.ts:191-200`                                                                             |
| G7  | `onPeerStage` receives `serviceId`, `pairId` and `stage` and keeps none of them                                                   | **S3** | No stage-transition history exists even in principle to build on                                                     | `management.ts:86-88`; `runtime-host.ts:136`                                                          |
| G8  | Docs tell the user to "send the logs" for `p2p.helper_unavailable` / `p2p.helper_closed`                                          | **S2** | The instruction is unfulfillable; there is no P2P log to send                                                        | `docs/p2p-connections.md:262`, `docs/p2p-connections.zh-CN.md:190+`                                   |
| G9  | No "copy diagnostics" affordance exists for P2P (one exists for Run rendering diagnostics only)                                   | **S2** | A user on a remote machine cannot hand over anything at all                                                          | `RuntimeTabsPanel.vue:317-320`, `:560-568`; `renderingDiagnostics.ts:14-34`                           |
| G10 | No OpenSpec requirement governs P2P diagnostics/logging, so there is no contract to build against                                 | **S3** | Each future fix re-invents evidence handling; nothing forbids persisting something sensitive                         | see (e)                                                                                               |

---

## (c) The five proposed ideas, judged

Cost is against this repository's own conventions (typed main-process code + Vitest,
`npm test -- --run`, one Agent Note, one OpenSpec delta).

| Idea                                                           | Cost                                                                                                                                                                                                                                                                                                                                 | Privacy exposure                                                                                                                                                                                                                                                                                                                                                                                                                                         | Usefulness for tonight's outage                                                                                              | Verdict                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **1. Typed P2P event ring + rotating file**                    | **Low–medium.** ~150 lines in main; reuses an established pattern (`launcher-harness-service.ts:889-901` bounded ring, `:884` `appendFile`) and the existing `diagnose` precedent                                                                                                                                                    | **Controllable and low if designed so**: persist `pairId`/`attemptId`/`generation`/`stage`/refusal code/`path.{localType,remoteType,protocol}` — none of which is an address, key or credential. `PeerHelperState` already cannot carry a URL/cookie/token (`helper-state.ts:14`) and `path` carries only ICE candidate _kinds_, never IPs or ports (`networking/internal/peer/transport.go:61-62`). Device ids need a short truncation, not full values | **Decisive.** Records exactly the sequence the outage lacked: attempt started → punching → failed with code, with timestamps | **Build first.**                         |
| 2. "Copy diagnostics" affordance                               | Low (a button + a bounded read). But _useless alone_ — it needs something to copy                                                                                                                                                                                                                                                    | Low: it copies what idea 1 stores, gated by an explicit user action                                                                                                                                                                                                                                                                                                                                                                                      | High, but only as the delivery mechanism for #1                                                                              | **Build second**, as the read side of #1 |
| 3. Per-attempt identifiers (`attemptID`/`pairID`/`generation`) | **Near-zero** — they already exist on the wire and in `PeerHelperState` (`helper-state.ts:6-7`; `signal.go:40,83`)                                                                                                                                                                                                                   | None new; `pairId` is already in `p2p-devices.json` and in the renderer's catalog view (`p2p-management.ts:143`)                                                                                                                                                                                                                                                                                                                                         | High — this is what lets two machines' journals be lined up                                                                  | **Do it as part of #1**, not separately  |
| 4. Stage timestamps                                            | **Near-zero** — one field in the record #1 writes                                                                                                                                                                                                                                                                                    | None                                                                                                                                                                                                                                                                                                                                                                                                                                                     | High: "connected 10 minutes ago and dropped" becomes provable                                                                | **Do it as part of #1**                  |
| 5. Persist Go-side (core writes its own log)                   | **High.** Touches Go, the packaged `dshkerd`, a new file under `--data`, plus the OpenSpec core method table and the packaging/preflight chain (`openspec/changes/go-owned-headless-core/tasks.md:74`, `.agents/notes/implemented/desktop/2026-09-14-core-refusal-families.md:9` — stale binaries are already an operational hazard) | Higher: whatever the core chooses to log is outside the shell's redaction boundary                                                                                                                                                                                                                                                                                                                                                                       | Real but redundant: the shell already receives, validates and holds every fact worth logging (`helper-state.ts:15-54`)       | **Reject for now.**                      |

Design note that makes #1 cheap: the shell does not need the core's stderr at all for
the _typed_ record. `PeerRuntimeHost.#handle` (`runtime-host.ts:119-149`) is already the
single choke point where every `peer.state` is validated and stamped. The stderr relay
remains worth keeping for the un-typed cases (`start <pairID>: <err>`, pion internal
noise), which is the residue #1 does not cover.

---

## (d) Ranked, minimal design for the single highest-value addition

### D1. What to build: a bounded, redacted P2P event journal (idea 1, absorbing 3 and 4)

One new main-process module, `electron/main/p2p/event-journal.ts`, owned by
`PeerRuntimeHost` and (for non-stage events) by `PeerManagement`. It records a typed
record per P2P event, keeps the newest N in memory, mirrors them to a rotating file,
and later feeds a copy affordance.

### D2. Where the code goes

| Change                                                                                            | File                                                                                                                                                                             | Why here                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| New `P2PEventJournal` class: `record(event)`, bounded ring, `appendFile` + rotation, `snapshot()` | `electron/main/p2p/event-journal.ts` (new)                                                                                                                                       | Mirrors `runtime-protocol.ts` / `helper-state.ts` as a self-contained, testable main-only unit                             |
| Construct it and pass it into the host                                                            | `electron/main.ts`, beside the `CoreSupervisor.start` call at `:288-299` (it needs `dataRoot`; the natural home is `path.join(launcherRoot, 'logs')` — see D4)                   | The journal must exist before the channel can produce events, and needs the same root the app already owns (`main.ts:211`) |
| Record stage transitions with their identifiers                                                   | `electron/main/p2p/runtime-host.ts:132-137` (the `if (state)` branch) — change `onPeerStage?.(serviceId, pairId, state.stage)` to pass `state`, or add a journal call next to it | This is the one place every `peer.state` is already validated and where `attemptId`/`generation` are in scope              |
| Record the operator-level refusals that never become a `peer.state`                               | `electron/main/p2p/management.ts:86-88` (the `onPeerStage` hook currently discards its arguments) and `:277-281` (`#refusalCode`, which today logs only untyped errors)          | Both are choke points that already see the code and the pair                                                               |
| Record channel death once, not per pair                                                           | `runtime-host.ts:191-200` (`#unavailable`)                                                                                                                                       | Record the real channel code here _before_ the blanket stage rewrite at `:196-198`, so G6 stops destroying the evidence    |

### D3. What it stores (the exact record)

```ts
interface P2PEvent {
  at: number // Date.now() — stage timestamp (idea 4)
  kind: 'stage' | 'refusal' | 'channel'
  serviceId: string // truncated to 8 hex chars before writing
  pairId: string // full: the coordinator's pair identity, correlates both machines (idea 3)
  attemptId?: string // full: the core's per-attempt identity (signal.go:83)
  generation?: number
  stage?: 'punching' | 'starting-runtime' | 'ready' | 'failed' | 'disconnected'
  code?: string // refusal code only — never a message (the code vocabulary is already closed: p2p-management.ts:454-648)
  path?: { localType: string; remoteType: string; protocol: string }
  runtimeGeneration?: number
}
```

Deliberately absent: any URL, token, cookie, `*.publicKey`, `privateKey`,
`certificate`, ICE candidate string, IP address or port. Every one of those is either
already impossible to obtain at this layer (`helper-state.ts:14`, `p2p-management.ts:226-230`)
or is on an explicit deny-list in the writer.

### D4. Bounding, rotation, location

- **In memory:** newest 500 entries, `push` + `splice(0, length - 500)` — the exact
  pattern already proven in `launcher-harness-service.ts:898-899` (which caps at 1 000).
- **On disk:** `~/.dshlauncher/logs/p2p-events.log`, beside `dsh-web.log`
  (`main.ts:235`), i.e. under a directory the app already creates and already tells
  users about (`docs/usage.en.md:44`). Max 1 MiB; on exceed, rename to
  `p2p-events.1.log` and start fresh, keeping exactly two files (bounded, predictable,
  ~2 MiB ceiling). One JSON line per event via `appendFile` — the same
  swallow-errors discipline as `supervisor.ts:139` and `management.ts:291`, so the
  journal can never itself break P2P.
- **Never a network call, never a renderer write, never a second writer.** One writer,
  in main, is what made `shell-diagnostics.log` and `core-diagnostics.log` safe; keep it.

### D5. Privacy constraints (hard rules for the implementation)

1. Refusal **codes only**. Exception text is already dropped at every boundary
   (`management.ts:278`, `management-ipc.ts:223-236`) — do not reintroduce it into a file.
2. Device identity is **truncated**, not omitted: write `serviceId.slice(0, 8)` and keep
   `pairId`/`attemptId` whole (they are coordinator-issued pair identities, already
   present in `p2p-devices.json`; `localDevice()` at `management.ts:344-363` shows the
   _device_ id is the long random value and it must not be written).
3. `path` stores candidate kinds only. This is structurally guaranteed today
   (`transport.go:61-62` has no address field) and must be asserted by a test (D7.3)
   so a future field addition cannot leak an address into the file.
4. No file contents, no project paths, no remote directory names — those already live
   behind `remote.*` and are out of scope for a connectivity journal.
5. The file lives under `~/.dshlauncher/logs`, which the user owns and can delete; no
   upload, no telemetry, no background transfer.

### D6. Second increment (the delivery half)

A "Copy P2P diagnostics" button in the pairing panel
(`src/app/shell/components/P2PPairingPanel.vue`, beside the existing
`data-testid="p2p-pairing-read"` action at `:106-114`), reusing the exact pattern of
`RuntimeTabsPanel.vue:317-320` + `:560-568` (including its `copyFailed` alert and the
`runtime.rendering.copyFailed` precedent at `i18n.test.ts:19`). It needs one new read
operation in the frozen P2P vocabulary (`P2P_MANAGEMENT_CHANNELS`, `p2p-management.ts:5-49`)
returning the bounded snapshot — and, per `AGENTS.md`, that is an IPC surface change
and therefore needs the OpenSpec update in (e) _first_.

### D7. How it would be tested

1. **Ring bound and ordering** (new `electron/main/p2p/event-journal.test.ts`): record
   501 events, assert `snapshot().length === 500` and that the oldest was evicted while
   order is preserved. Cost: pure unit test, no Electron, mirroring
   `launcher-harness-service.test.ts:32`.
2. **Rotation**: write past 1 MiB into a `tmpdir`, assert `p2p-events.1.log` exists, the
   live file is under the cap, and exactly two files remain after several rotations.
3. **Redaction, asserted negatively**: feed a synthetic state whose `path` contains an
   address-shaped string and whose `serviceId` is a 32-hex device id; assert the
   serialized line matches neither `/\d{1,3}(\.\d{1,3}){3}/` nor `/:[0-9]{2,5}\b/` and
   contains no full device id.
4. **Wiring through the real choke point**: extend `electron/main/p2p/runtime-host.test.ts`
   with an injected fake channel that delivers a `failed` `peer.state` carrying
   `p2p.direct_unavailable`; assert the journal received one `stage` event with the
   `attemptId`, `generation` and code intact — this is the case that is silently lost today.
5. **Channel-death ordering**: assert `#unavailable` records the channel code as its own
   event before rewriting per-pair stages (`runtime-host.ts:191-200`), so G6 is fixed
   rather than frozen into the log.
6. **Failure containment**: a journal whose directory is read-only must not propagate —
   assert the P2P operation still succeeds (same discipline as the existing
   `.catch(() => undefined)` in `supervisor.ts:139`).
7. **No-secret regression**: a case that runs a full connect against the existing
   fake-core fixture (`electron/main/core/supervisor.test.ts:19` skip guard, reusing its
   fixture harness) and greps the produced file for the bootstrap secret — it must be absent.

### D8. Which one first, and why

**Build the journal (D1–D5) first, alone, as one change.** It is the smallest artifact
that converts tonight's four-hour debugging session into a single file read, it needs no
IPC change (so no renderer admission churn), it reuses two patterns already in this
codebase, and it is the prerequisite for every other idea on the list. The "copy
diagnostics" button is the natural second increment but cannot exist without something
to copy; per-attempt ids and timestamps are free riders inside the same record; and a
Go-side log is a much larger change that duplicates evidence the shell already holds.

---

## (e) Renderer-side stage history: what a user can distinguish

**There is no history. Only the current stage.**

- The renderer's entire connection state is `{ peers, helperError, resultUnconfirmed }`
  (`src/app/domains/remote-connections/p2pConnections.ts:8-13`), and `read()` replaces
  `peers` wholesale (`:56-64`). `find()` (`:67-69`) returns the single live view.
- `#scheduleFollowUp` (`:39-49`) polls every 2 s _only while_ a peer is in
  `punching`/`starting-runtime`, and stops the moment nothing is negotiating — so the
  last observed stage is simply frozen until something else overwrites it.
- The per-pair state in main is likewise one slot, overwritten in place
  (`runtime-host.ts:46`, `:135`).
- The single attempt-keyed structure in the whole renderer is
  `P2PWorkReconciliationDomain.#records` (`p2pWorkReconciliation.ts:20-29`), keyed
  `serviceId:pairId`, storing `{ attemptId, generation, runtimeGeneration, workStarted, reconciled }`.
  It exists to answer "did my in-flight task survive?" (`verdict()`, `:91-111`) — **not**
  "what happened to the connection". It records nothing about a _failed_ attempt that
  never reached `ready` (`noteWorkStarted` requires `stage === 'ready'`, `:56-58`), it
  holds no timestamps, and it dies on reload.
- `RuntimeTabStatus` (`runtimeBrowserState.ts:21-25`) is a four-way sum with one
  `failed` variant and a single `code` — a state, not a log.

**Therefore: no, a user cannot distinguish "it connected 10 minutes ago and dropped"
from "it never connected".** Both render as the same thing. The nearest hint is the
`p2pWorkReconciliation` warning, and it only appears if the user had _explicitly_ pressed
"note work started" while ready (`P2PPairingPanel.vue:208-216`) — and even then it says
"the outcome is unknown", not when it happened. `disconnected` in
`runtimeBrowserState.ts:74` is also the default arm for any unrecognized stage, so a
never-connected pair and a cleanly dropped one are literally the same value on the Run page.

---

## (f) Governing OpenSpec / Agent Note convention, and whether a change is needed

### F1. What exists

- **No OpenSpec capability spec exists for this app.** `openspec/specs/` is absent
  (verified: `Test-Path apps\dsh-launcher\openspec\specs` → `False`). `openspec/changes/` holds four
  un-archived changes — `add-managed-harness-desktop-shell`,
  `add-managed-remote-dsh-connections`, `add-self-hosted-p2p-dsh-connections`,
  `go-owned-headless-core` — each with `.openspec.yaml`, `proposal.md`, `design.md`,
  `tasks.md` and `specs/<capability>/spec.md`.
- **Nothing governs P2P diagnostics or logging.** Grepping `openspec/` for
  `diagnostic|logging|trace` returns only the _managed Harness runtime_ requirements
  (`.../specs/harness-runtime-supervision/spec.md:49-51`), the _Run-page rendering_
  observation (`.../specs/desktop-launcher-experience/spec.md:318-320`,
  `.../specs/desktop-renderer-authority/spec.md:33`), and the console-color rules
  (`.../specs/desktop-launcher-experience/spec.md:285`). None of them mentions P2P, the
  core child, or a peer connection.
- **Agent Notes convention** (`.agents/notes/`): `YYYY-MM-DD-<kebab-slug>.md`, flat at the
  top level while in flight, moved under `implemented/<category>/` when archived — e.g.
  `.agents/notes/2026-09-14-task-3-8-failure-codes.md` and its archived sibling
  `.agents/notes/implemented/desktop/2026-09-14-core-refusal-families.md`. Notes are
  retrospective and evidence-bearing (what was wrong / what landed / verification /
  platform results), not specifications.
- **`AGENTS.md` is explicit:** "The renderer never receives arbitrary filesystem, shell,
  Git, subprocess, credential, or dialog access. Add a named typed operation only after
  updating the OpenSpec and its admission tests." And: "For any non-trivial product, IPC,
  persistence, or release change, update the active OpenSpec change and add an Agent Note
  under `.agents/notes/`."
- **`openspec/config.yaml`** fixes the artifact shape: `proposal` must state target user,
  desired outcome, explicit non-goals and affected repositories, separating Launcher-owned
  behavior from required Harness changes; `design` must define directory ownership, data
  flow, IPC versioning, security, **failure behavior**, and recovery, and must record
  rejected alternatives; `specs` must carry scenarios. `operations.archive` requires
  strict OpenSpec validation plus packaged macOS and Windows evidence.

### F2. Does the journal need an OpenSpec change first?

Split the answer, because it decides the implementation order:

- **The journal alone (D1–D5): no OpenSpec change is strictly required.** It adds no
  renderer operation, changes no preload surface, and adds no IPC channel. It is a
  main-process, Launcher-owned persistence file — but it _is_ a "persistence change" in
  the sense of `AGENTS.md`, and it deliberately writes device-correlated identifiers to
  disk. Per `openspec/config.yaml` the `design` artifact is where directory ownership,
  data flow and security belong, so the honest minimum is: **an Agent Note is mandatory,
  and the file should be added as a task under the active change it belongs to**
  (`go-owned-headless-core`, whose §3.8 already owns failure-code observability —
  `tasks.md:51-54`, still open on its "observable from the CLI" half) so the requirement
  is not orphaned.
- **The copy affordance (D6): yes, an OpenSpec change is required before implementing.**
  It introduces a new named typed operation in `P2P_MANAGEMENT_CHANNELS`
  (`src/shared/p2p-management.ts:5-49`), which is precisely the case `AGENTS.md` gates on
  ("Add a named typed operation only after updating the OpenSpec and its admission tests").
  The gate is real and already enforced: `electron/preload-surface.golden.json` records
  all 88 dotted operation paths and `electron/preload-surface.test.ts` asserts the
  surface in both directions, refusing an invoker or channel name
  (`openspec/changes/go-owned-headless-core/tasks.md:9`), so adding an operation without the
  OpenSpec/update procedure fails a test by design.

Recommended sequencing, therefore: journal + Agent Note under the existing
`go-owned-headless-core` change first (no new capability spec needed); copy affordance as
its own OpenSpec change with a `specs/.../spec.md` scenario set and the
`PRELOAD_SURFACE_UPDATE=1` golden refresh second.

---

## Appendix: the shortest path for tomorrow's on-call

1. Ask the user for `~/.dshlauncher/core-data/core-diagnostics.log` — it will confirm
   whether the core started at all (handshake outcome, exit code). **This exists today.**
2. Ask for `~/.dshlauncher/logs/dsh-web.log` — the DSH Web child, not the peer path.
   **This exists today.**
3. Ask for the settings-root `dsh-launcher/shell-diagnostics.log` — it will be empty for
   any typed P2P refusal. **This exists today and is the wrong shape.**
4. Everything else — the stage, the attempt, the refusal code — must be reproduced with
   `DSH_P2P_TRACE=1` and `PION_LOG_TRACE=all` set before launch, because nothing in the
   packaged app retains it. **This is the gap.**
