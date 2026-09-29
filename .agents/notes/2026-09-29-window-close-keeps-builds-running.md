# Protecting Harness operations from window-close shutdown

## Problem

The initial close guard did not cover every lifecycle path. It could hide an
active window without a working tray, was attached only to the first window,
did not cover the first-run bundled checkout, and stopped protecting the user
once the active-version pointer changed but old-worktree cleanup was still
running. Concurrent renderer requests could also mutate the same checkout.

## Change

- Harness mutations now reject a second request synchronously with the typed
  `runtime.operation_in_progress` error; the shared operation log cannot be
  closed by another concurrent request.
- Bundled first-run preparation counts as active work. Version switching stays
  active until old-worktree cleanup has finished or reported its failure.
- Every new application window is bound to the tray and its close guard. With
  an active task, close hides only if the tray exists; otherwise it keeps the
  window visible. Dock reactivation points the existing tray at the new window.
- Tray-active state now requires an actual tray icon, so Windows does not keep
  an invisible process alive after tray creation fails.

When no managed operation is in flight, the saved close preference still
controls close behavior. Explicit quit from the tray still releases the close
interception and performs the full shutdown sequence.

## Validation

Regression tests and real macOS/Windows close/reopen acceptance are pending.
Build and static checks alone do not prove that an actual long-running Git or
pnpm process survives window close and completes with a valid active-version
pointer.
