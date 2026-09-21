# Core single-owner handoff and VFS source-size repair

## Context

The desktop could detect an installed headless `dshkerd`, but the shutdown path
closed its authenticated socket without a protocol acknowledgement. Disabling
autostart or quitting during a reconnect could therefore race the headless
owner, leaving an `owner_busy` state or a second device identity on the next
launch. The foundation VFS module had also grown beyond the source-file review
limit.

## Changes

- `CoreSupervisor` now attaches to a registered headless endpoint and sends
  `core.desktop_handoff` before closing an attached socket. An enabled
  registration returns an explicit conflict and the headless service remains;
  a disabled registration exits only after the desktop has received the
  acknowledgement.
- Launcher shutdown closes peer/SSH/broker owners before handing the core back,
  so no late callback races the handoff. Go-side owner locking, attach,
  disconnect, stale endpoint cleanup, and platform registration ownership are
  covered by focused, race, vet, and Windows cross-build checks.
- Split `packages/desktop-foundation/src/vfs.ts` into type, path/policy,
  resource-catalog, and memory-storage modules while retaining the barrel
  exports and behaviour.

## Verification

- Vitest: 164 files, 1,459 tests passed with an explicitly rebuilt dshkerd core.
- Go focus, race, vet, headless smoke, and six-target CLI distribution checks
  passed; external integration tests still require explicit
  `DSHKER_SERVER_BINARY` and `DSHKER_TEST_HARNESS_ROOT`.
- `type-check`, `format:check`, `architecture:check`, `visual:smoke`, renderer
  build, Electron build, source-size gate, and desktop-app validation passed.
