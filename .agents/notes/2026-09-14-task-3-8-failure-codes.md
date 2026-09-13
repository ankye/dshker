# Task 3.8: failure codes stay distinguishable end to end

Date: 2026-09-14

## What was wrong

Two boundaries collapsed refusals into `p2p.operation_failed`, so the shell could
not tell a direct-path failure from a runtime failure from an authorization
failure — the exact distinction 3.8 protects.

1. **A wrapped sentinel lost its code.** `internal/secret` reports
   `fmt.Errorf("%w: value too large", ErrWrite)`, whose message is
   `p2p.secret_write_failed: value too large`. The private channel accepted only
   messages that were a bare code, so that became `p2p.operation_failed`. The
   session manager had the same rule spelled differently — it rejected anything
   containing a space — so the same sentinel was classified one way by the
   channel and another by the manager.
2. **A raw transport sentence reached the shell.** `Manager.Connect` returned the
   unprocessed cause when an attempt failed, even though it had already computed
   a named refusal for the state it emitted. A screen full of `pion` diagnostics
   is not a code, so the shell recorded `p2p.operation_failed` for what was
   honestly "no direct path".

## What landed

- `protocol.Refusal(err)` is now the single rule: a refusal is the message, or
  the prefix of a message before its first `:`, validated as a public code, and
  it consults the wrap chain outermost-first so `fmt.Errorf("...: %w", sentinel)`
  and `fmt.Errorf("%w: detail", sentinel)` both keep their code. The detail is
  dropped on the way out, because a shell can act on the classification but not
  on a Win32 or Keychain sentence.
- `localrpc.publicError` and `peersession.namedRefusal` both call it, so the two
  layers cannot disagree again. The inbound check in `localrpc` is unchanged and
  still strict: a frame whose error field is not exactly one bare code terminates
  the connection.
- `Manager.Connect` returns the attempt's named refusal instead of the raw cause,
  through a new `session.refusal` recorded where the state is built.

## Verification

- `internal/protocol/refusal_test.go`: 19 cases over the rule — bare codes,
  wrapped codes, a Win32 detail, a nested wrapper, a code quoted inside a detail,
  an over-long code, an uppercase prefix, spaces, newlines, hyphens, and nothing
  at all.
- `internal/localrpc`: the existing redaction case now also proves a wrapped
  sentinel keeps its code, which is the case that failed before the fix.
- `integration/failure_codes_test.go` drives the **real daemon** through the real
  private channel and asserts three different named codes, none of them the
  generic fallback: an unpinned pair is `p2p.pair_unauthorized`, browsing with no
  session is `p2p.not_connected`, and connecting to a pair whose computer is not
  running is `p2p.peer_offline` — answered by the coordinator in 4 ms, before any
  path is attempted, and localized by the renderer.
- The "and the CLI" half of 3.8 waits for P5: there is no headless entry point to
  observe the codes from yet, so it is recorded under 6.1 rather than claimed here.
- `networking/docs/shell-core-protocol.md` §5 now states the wrapping rule and
  lists `p2p.peer_offline` among the codes a shell must distinguish.
- `src/shared/p2p-management.test.ts`: the shell's own vocabulary names every code
  this test proves the core can send, so each one reaches the renderer as a
  localized message rather than a raw string; the list is also checked for
  duplicates, since a duplicate is how a rename hides.
- macOS: `go build`, `go vet` (native and `GOOS=windows`), every unit package and
  the full `integration` suite (264.5 s); `format:check`, `architecture:check` and
  the full unit suite (154 files, 1274 tests).
- Windows (Go 1.26.4): `go build`, `go vet`, every unit package, all five
  `TestCoreDaemon*` cases (9.7 s, including the new failure-code test at 1.86 s)
  and the 12-test integration subset re-run uncached (253.9 s) all pass.
