# Task 3.6d: the shell stops launching a peer helper

Date: 2026-09-14

## What landed

One process answers the peer table now, so the shell launches one child instead
of two:

- `electron/main/p2p/runtime-host.ts` takes a `PeerChannel` — `call`, `serve`,
  `observe` — instead of a `resourcesRoot` to spawn from. `PeerRuntimeHost.start`
  no longer spawns anything: it reads the catalog for the enable gate, attaches
  the two parent-role callbacks, and returns the channel that `PeerServices`,
  `PeerAccounts`, `PeerConnections`, `PeerEnrollment`, `PeerPairing` and
  `PeerRemoteProjects` already spoke over.
- `CoreSupervisor` is that channel. It routes the core's callbacks through one
  mutable dispatch slot, because the core is started at app ready and the peer
  state machine is composed after it: `serve()` installs the handler and
  `observe()` reports the channel's death. Before anything attaches, a callback
  gets `p2p.not_implemented` rather than a silent hang.
- `PeerSupervisor` and its options interface are deleted; `p2p/supervisor.ts`
  keeps only `stopChild`, `exitedWithin` and `verifyHelperResource`, which the
  core's own supervisor uses. `verifyHelperResource` still understands both
  packaged binary names, because `dshker-peer` stays packaged until P6.
- `main.ts` passes the core supervisor as the channel. A shell that could not
  start a core has no transport, and P2P reports `p2p.helper_unavailable` instead
  of silently degrading to a process that no longer exists.
- `tools/p2p-preflight.mjs` verifies `dshkerd` against
  `dshkerd-manifest.json`. It checked `dshker-peer` while the shell ran that
  binary; leaving it would have given a false pass to a machine whose core is
  broken. Both `docs/p2p-connections.md` and its Chinese counterpart now say
  "core" where they said "helper".
- `CHANGELOG.md` gains the one line a user can actually observe — one background
  process, and a core that cannot start now reports P2P as unavailable — under a
  new `## Unreleased` heading for the release step to rename. The READMEs do not
  mention the helper or either binary, so neither went stale.

## Two behaviours that changed on purpose

- **Failure containment detaches, it does not kill.** The old host closed its own
  child on failure. The channel belongs to the shell and is shared with the
  catalog and the credential store, so the host releases its callbacks instead.
  A failure that leaves the core alive keeps serving, so the core still receives
  the real reason rather than a bare `p2p.not_implemented`; a dead channel
  detaches first, because nothing can be delivered through it again.
- **No core means no P2P.** There is no second helper to fall back to. That is the
  point of the change, and it is reported as a typed refusal.

## Verification

- `electron/main/core/supervisor.test.ts` gained a case that runs over a **real
  socket** against the scripted core fixture, which now issues a
  `runtime.connect` after every `core.version` it answers. It proves the three
  states of the dispatch: nothing attached → `p2p.not_implemented`; attached →
  the handler's answer (`{generation, url}`) crosses back; detached → the refusal
  returns. This is the only place the shell`↔`core callback shape is exercised
  end to end rather than through a fake channel.
- `runtime-host.test.ts` and `management.test.ts` were ported from mocking
  `PeerSupervisor.start` to injecting a fake channel, and their assertions now
  name what actually happens: `attach`/`detach` counts, no implicit reattach,
  and the state machine fenced after a failure.
- macOS: `format:check`, `architecture:check`, `build:electron` and the full
  unit suite (153 files, 1272 tests) pass.
- Windows: the same suite against the real `dshkerd.exe` via
  `DSHKER_CORE_BINARY`, where the scripted-fixture case is skipped because that
  fixture is a Node script and Windows needs an executable.

## Not done, deliberately

`dshker-peer` is still built and packaged (~17 MB per platform) though nothing
starts it. Removing it touches `tools/build-peer-helper.mjs`, the electron-builder
configuration, the preflight tool and the packaging tests at once, and P6 is where
the shell is declared free of the peer helper. Recorded rather than half-done.
