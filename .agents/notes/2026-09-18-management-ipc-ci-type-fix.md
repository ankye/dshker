# Management IPC CI type-check fix — 2026-09-18

## Failure

Release `v0.1.60` failed in both the quality and package workflows before tests
or builds. TypeScript reported TS2367 at
`electron/main/p2p/management-ipc.test.ts:401`: the test compared a value
typed as `P2PManagementOperation` with the internal-only `resumeConnectivity`
helper.

## Cause and fix

The `connect` IPC route calls `owner.resumeConnectivity()` before dispatching
the named `connect` operation. The fixture therefore has one extra owner key,
but the test cast `Object.keys(owner)` to only dispatched operation names. The
fix models the runtime key set as `RoutedOperation | 'resumeConnectivity'`,
uses a type guard to exclude the helper from the dispatch loop, and asserts the
connect route calls it once. The helper remains outside the versioned renderer
IPC operation union.

## Evidence

- GitHub run `35301914992` and package runs `35301914947`/`35301917864` all
  stopped at the same type error.
- `npm run type-check` passed locally.
- `npm test -- --run electron/main/p2p/management-ipc.test.ts` passed: 92/92.
- The existing P2P test-integrity manifest also had a stale `pending_target_approval`
  assertion; it now matches the current `invited` protocol state.
