# Task 6.1, the hosting half — a headless host can name its workbench

Date: 2026-09-14
Change: `go-owned-headless-core` (P5/P6, task 6.1, carried into 6.2)

## What was missing

The first half of 6.1 published `serve`, `status`, `roots`, `dsh start|stop`, `call`,
`pair` and `connect`. Two things were still absent, and one of them was a hole
rather than a missing convenience: a headless core refused `runtime.connect`
unconditionally with `p2p.runtime_unavailable`, so a machine with no desktop
session could hold a peer transport but could never hand that peer a workbench.
The requirement it broke is the one the change exists for — "a machine with no
display hosts a workbench that a desktop peer opens" — and it would have surfaced
as a 6.2 failure with no explanation on the peer side.

## What changed

The core now owns the runtime binding, which is what a peer is handed when it asks
this host for a runtime. `core.RuntimeBinding` answers from the child the core
supervises: the loopback address the running child announced, and the generation
that identifies it. `headlessMain` answers the parent-role `runtime.connect` from
the same object, so the desktop path and the headless path give a peer the same
shape of answer from different owners.

The generation rule is the desktop runtime owner's, ported rather than
reinvented: one running child that keeps the same address is one generation, so a
peer that reconnects to an unchanged child is not told its proxy target moved; a
replaced child, or the same child announcing a different address, is the next
generation; and no running child is `p2p.runtime_unavailable` — the code the
desktop owner reports for a stopped or failed child, so a peer cannot tell which
half of the product it is talking to. The binding is recomputed on every ask and
never cached, because the child can be replaced between two questions and a
binding that names a dead address is worse than no binding at all.

Two named commands expose it, both sugar over the published table:

- `dshkerd proxy [--json]` asks `core.runtime_binding`, which is additive to the
  version 1 table, and prints the address and generation this host would give a
  peer. This is the reverse-proxy half of hosting asked directly, so an operator
  with no display can see exactly what a remote is handed.
- `dshkerd service configure --origin URL [--wss URL] [--stun ADDR] [--pinned-key
FILE] [--version V]` makes the same `service.configure` call the shell makes
  when a user enters a coordinator, with the endpoints read from flags. A pinned
  key file must hold exactly the 32 bytes the host admits, and a missing or padded
  file is refused here rather than by the coordinator.

The `core.runtime_binding` method is declared `RoleShell` in the published table,
not `RoleParent`: `runtime.connect` is formally a callback the core sends to its
parent, and a client calling a parent-role method on the core is a protocol
violation. The address carries a session credential, so it stays a main-side value
on the private channel the bootstrap created — the same exposure `runtime.status`
already has, and the reason `proxy` prints it only when an operator asks.

## Evidence

- `internal/core/runtimebinding_test.go` drives the generation rule through a
  stand-in child authority: no authority, no child, and each of starting, stopped
  and failed are the refusal; one child is generation 1 and stays 1 when asked
  twice; a new address and a replaced launch are generations 2 and 3.
- `integration/cli_test.go` extends the headless run end to end: `proxy` refuses
  with `p2p.runtime_unavailable` before any child exists, answers generation 1
  with the announced `127.0.0.1:3099` while the stub child runs, renders the same
  fact as a line without `--json`, and refuses again once `dsh stop` has ended the
  child. `service configure` without an origin is refused before any call.
- `core.version` advertises the new method, and the frozen payload expectation in
  `internal/core/server_test.go` was updated with it — the change is additive
  within `MethodTableVersion = 1`.
- Green: `gofmt`, `go build`, `go vet` for the host and for `GOOS=windows`, every
  Go package, and the fixture-backed integration suite.

## Still open in 6.1

Nothing named by the task. The three _connection_ failure families still need a
live coordinator to be exercised through the CLI, which is 6.2's job rather than
this one's, and the headless host's own hosting run is the 6.2 acceptance.
