# First run with a known settings root, and what still breaks the connection

Date: 2026-09-14
Change: `go-owned-headless-core` (P6, tasks 6.2 and 7.5)

## Landed

`ManagedWorkspaceService.getState` classified a missing registry document as
`recovery-required` for every root, so the only state that created the product
defaults was a missing _bootstrap locator_. A machine whose locator names a
settings root whose document is not there — a first install on a root that was
already recorded, or a settings root whose file was removed — therefore had no
path to the defaults at all: the plan said "recovery required", the launcher said
it could not start, and the console showed the core's refusal
(`core.roots_inspect: managed.missing_registry`) followed by an unrelated
`p2p.protocol_mismatch` that hid it.

The refusal is now read for what it is: a known root that has no document yet is
that root's first run, so the defaults are registered and the launcher starts.

Evidence: `npm run type-check`, `npm run format:check`, and
`npx vitest --run electron/main/managed electron/main/p2p` — 46 files, 548 tests,
all green.

## Not landed, and why

The connection defect the same session found is **not** fixed here, because the
first attempt at it was wrong and was reverted rather than left half-done.

What is established by reading the code:

- `electron/main/p2p/management.ts#goOnline` walks the services the catalog
  records and calls `#readyAsDevice` for each. When the store has no credential,
  `#readyAsDevice` refuses with `p2p.device_unregistered`, `goOnline` records
  `offline` with that code, and nothing ever enrolls again — the record in
  `p2p-devices.json` still says the device is registered, so the app has no
  reason to.
- Changing that refusal's code to `p2p.credential_unavailable` (the accurate
  name) breaks three tests in `management.test.ts` that pin the current contract,
  and the code is also mapped in three user-visible surfaces
  (`src/shared/p2p-management.ts`, `src/app/domains/remote-connections/p2pPairing.ts`,
  `p2pConnections.ts`). A rename is a contract change, not a fix.

The fix is behavioural and belongs in `goOnline`: a service the catalog records
whose `loadRegistration` answers `absent` must **enroll again** — create the
credential, never migrate one — and only when no account session can be used
should it report a named state the surface can explain ("sign in again to enroll
this machine"). The desktop-window gap (`runtime-browser-controller.ts` loading a
persisted address that nothing serves, surfacing as `GUEST_VIEW_MANAGER_CALL -3`)
is likewise still open: `did-fail-load` is handled nowhere except
`electron/main/smoke.ts`.
