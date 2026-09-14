# The Windows credential store lost writes behind a concurrent read

Date: 2026-09-14
Found by: the Windows half of the P3 verification run (task 4.2 evidence)
Change: `go-owned-headless-core`

## What was wrong

`TestStressConcurrentStoreOperations` failed on the Windows box in two to three
runs out of five, with

    worker 3 set 0: p2p.secret_write_failed: rename ...credentials.json.tmp ...credentials.json: Access is denied

and then `p2p.secret_missing` for the keys whose write had been refused. This is
not a test artefact: a `Get` that happens to be reading the blob while a `Set`
replaces it made the `Set` fail, so the core could refuse to persist a device
credential because something else read the file at the same moment. The comment
on that store already claimed the atomic replace kept readers safe; the replace
was simply not atomic on Windows in the presence of a reader.

## What the platform actually does

Measured on the box rather than assumed, because the documented behaviour says
the opposite. Four cases, an open reader on the destination and a replacement
ready to rename over it:

| reader handle                                                   | replace result   |
| --------------------------------------------------------------- | ---------------- |
| none                                                            | success          |
| `os.Open` (share read + write)                                  | Access is denied |
| `CreateFile` with `FILE_SHARE_DELETE` (share read+write+delete) | Access is denied |
| source `.tmp` held open with `FILE_SHARE_DELETE`                | success          |

and the same with `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` directly:
`FILE_SHARE_DELETE` on the reader still answers `Access is denied`. So the
share-mode route does not exist on this platform through either API, and the fix
has to be "wait for the reader", not "let the reader share". The first attempt
in this round — opening the blob with `FILE_SHARE_DELETE` — was measured to be a
no-op and was removed rather than kept as decoration.

## The fix

`dpapiStore.replace` retries the rename for at most 250 ms, sleeping 1 ms
between attempts, and retries only the three transient Windows refusals
(`ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION`). Any
other error is reported immediately, and a handle that never goes away still
fails the write inside the budget instead of hanging it. Nothing else changed:
D5's one writer per store is intact, the mutex still serialises read-modify-write
cycles, and the reader continues to see the previous complete store.

## Evidence

- `TestReplaceWaitsForAReaderThatClosesQuickly` (Windows-only): a reader is held
  open, a write is started behind it and is still running after 5 ms, the held
  reader still sees the complete previous store, and the write completes once the
  reader closes — then both keys are readable.
- `TestReplaceRefusesAForeignHandleThatNeverReleases` (Windows-only): a handle
  opened without delete sharing keeps the destination locked and the write is
  reported as `p2p.secret_write_failed` rather than waiting forever.
- `TestSharingViolationClassifiesOnlyTransientWindowsErrors` (Windows-only): the
  three retryable errno values are retried and a missing file, a full disk and a
  plain sentinel are not.
- `TestStressConcurrentStoreOperations`: **failing in 2–3 of 5 runs before,
  passing 6 of 6 after**, on the same box with the same command.
- The full Windows unit suite (`go test ./internal/... ./cmd/...`) is green after
  the fix, and macOS is unaffected (the file is Windows-only).
