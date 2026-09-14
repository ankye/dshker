# The network you chose is remembered

Date: 2026-09-14
Change: `go-owned-headless-core` (P6) — remote-connections surface

## Why

Selecting a network was never remembered, so an owner with several networks
re-picked the same one on every visit. The panel deliberately never guessed, so
the only way to remove that friction was to remember a real decision.

## What changed

- `selection-preferences.ts` stores one entry per service and account in
  `dsh-launcher/p2p-selection.json` below the registered Settings root: strict
  `format`/`version`/`services`, atomic write, `0600`, symlinks refused, unknown
  fields, future versions and malformed ids refused, and a path that escapes the
  Settings root refused.
- Two named operations carry it across the frozen renderer surface —
  `accountSelection` (read, `serviceId` + `userId`) and
  `rememberAccountSelection` (write, `serviceId` + `userId` + `networkId`) — with
  their admission field lists, IPC routes and `p2p-management-preload` entries.
  The golden surface was re-recorded with `PRELOAD_SURFACE_UPDATE=1`.
- `P2PAccountsDomain` resolves the selection in one order: the account's own
  remembered network while it is still in the list, then a single network, then
  nothing. Only an explicit `select` writes; an automatic selection is a default
  and is never stored as intent. `select` is now async so the write is awaited
  rather than racing the next read.

## Evidence

- `npm run type-check`, `npm run format:check`, `npm run architecture:check`
  (no findings), full vitest suite.
- Domain tests: restores the remembered network for its own account; ignores a
  remembered network that is gone and then never guesses; writes only on an
  explicit selection (the automatic one is asserted absent).
