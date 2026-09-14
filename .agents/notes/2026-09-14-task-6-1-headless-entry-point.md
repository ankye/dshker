# Task 6.1 — the headless entry point

Date: 2026-09-14
Change: `go-owned-headless-core` (P5, task 6.1)

## What runs now

`dshkerd serve` runs the core for a machine with no desktop session. It has no
parent, so it publishes its own endpoint instead of reading a bootstrap record
from stdin:

- a per-user state directory (`--state`, else `$DSHKER_STATE_DIR`, else
  `~/.dshkerd`) created `0700`;
- the endpoint inside it — `peer.sock` on Unix, a per-user pipe name on Windows —
  created by the same `localrpc.Listen` the shell's child uses, with the same
  guards;
- `core.json` beside it, holding exactly the shape of the stdin bootstrap
  (`version`, `socket`, 32-byte hex `secret`) written `0600`. A client that can
  read that file is this user, which is the whole claim.

The same composition as the shell's child is behind it: the credential store, the
device catalog, the installed-peer host and the DSH Web supervisor, answering the
same published table. The only new piece of policy is
`headlessMain`: `peer.state` is accepted and dropped (there is no renderer to
inform) and `runtime.connect` is refused with `p2p.runtime_unavailable` — a
headless core can own a remote peer's runtime only once a child has been started
for it, and pretending otherwise would be worse than refusing by name.

## The commands

```text
dshkerd status [--state D] [--json]
dshkerd roots  --registry FILE --native-home DIR [--state D] [--json]
dshkerd dsh start --directory DIR --pnpm FILE [--pnpm-prefix A] [--patch FILE] [--port N] [--state D]
dshkerd dsh stop [--state D]
dshkerd call   <method> [json|-] [--state D]
```

With no subcommand the binary is still the shell's child and bootstraps from
stdin, so an installed shell keeps working unchanged.

`call` is what makes the surface whole: every published operation is reachable
before it has a friendlier command, the refusal code is printed verbatim, and a
payload can come from stdin. The named commands are sugar over it.

## The two carry-forwards

- **3.8, failure codes from the CLI.** The integration test drives three
  refusals through the real binary and asserts three different codes on the
  terminal with exit 1: `p2p.invalid_operation` for a method that does not
  exist, `runtime.not_found` for a subject that never ran, and
  `managed.missing_registry` for a registry that is not there. None of them is
  the generic fallback. The three _connection_ families 3.8 lists
  (`p2p.pair_unauthorized`, `p2p.not_connected`, `p2p.peer_offline`) need a live
  coordinator and are asserted through the private channel today; running the same
  three through the CLI against the integration fixture is carried to 6.2.
- **4.1, the same roots from both sides.** The test commits a registry through
  `call core.roots_commit`, then prints it with `dshkerd roots` and asserts all
  four kinds with their ids and paths. One writer (the core), two readers (the
  shell and the CLI), one file.

## Evidence

- `internal/localrpc`: the endpoint record round trip, its `0600` mode, the one
  file name it accepts, a malformed record refused, and a listener that answers
  two sequential authenticated clients, refuses a foreign secret, and keeps
  serving afterwards.
- `integration/cli_test.go`: a real `dshkerd serve` process, real client
  processes, readiness, `status`, the roots round trip, the missing-registry
  code, `dsh start` running a real child to its announced URL, `dsh stop`,
  the three distinct codes, and `p2p.helper_unavailable` once the daemon is gone
  — the CLI reports an unreachable endpoint by name instead of hanging.
- macOS: the package tests, `cmd/dshkerd` tests and the integration suite pass.

## Windows

The same commands run on the box, through the console session the credential store
needs:

- `serve` publishes a pipe endpoint (`\\.\pipe\dshker-peer-<32 hex>`) and reports
  readiness;
- `status` answers "core version 1, 55 methods";
- `dsh start` starts a real child (pid recorded) and `status --json` reports it
  `running` with the URL the child announced;
- `dsh stop` reports the record as `stopped` — with `exitCode:1`, which is how
  Windows reports a forced tree kill, and exactly why a requested stop has to be
  recorded explicitly rather than inferred from the exit code;
- `call nope.nope` exits 1;
- the whole Go unit suite is green on that host.

One test was wrong for Windows and only Windows could say so: the serving test
built its pipe prefix with four backslashes, so `Listen` refused it with
`p2p.invalid_socket` while the sibling assertion passed on Unix, where the
endpoint is a path. The value is now written as a raw string, which is what the
production `serve` path already did.

## Still to do in P5

- `pair` and `proxy` have no named command yet; both are reachable through
  `call` today.
- 6.3 and 6.4: the core binary is already built and manifest-verified per
  platform by `tools/build-peer-helper.mjs` and `CoreSupervisor`, but the release
  readiness pass does not yet name the headless entry point.
- The Windows run of the same commands is recorded with the round that verifies
  this commit on that host.
