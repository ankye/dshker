# Task 3.7, core half: one process answers the whole method table

Date: 2026-09-14

## What landed

`dshkerd` now composes the same `helper.Host` that `dshker-peer` runs. The core
answers its own `core.*` methods against its stores and hands every other
published shell-role method to that host, so a coordinator, pairing, enrollment
or runtime operation no longer needs a second child process to reach. `core.Serve`
gained a `Peer` interface (`Handle(ctx, method, payload)`), the private channel is
bound to the host before the first request is answered so the two parent-role
callbacks (`runtime.connect`, `peer.state`) work, and `core.version` reports the
composed table.

A composition without a host — the helperless unit tests — still refuses peer
methods with `p2p.not_implemented`, which now means exactly two things: no peer
host, or a published `core.*` method this build has not implemented. Anything not
in the published table is `p2p.invalid_operation` before another line looks at it,
and an inbound parent-role method is refused the same way, because the core sends
those rather than answers them.

## The gap this exposed

The shell has always called `device.createKey` and `device.createCSR` during
enrollment, and neither was in the published table. The table is supposed to be
the frozen description of the shell/core contract, so it was describing less than
the contract. Both are published now — additive within version 1, like the
catalog methods in 3.6b — which is also what makes the routing exact: gating on
the table is only sound if the table is complete.

## Verification

- `internal/core/server_peer_test.go`: 6 cases. The core's own methods never
  reach the host, the host's methods never reach the core, an inbound callback is
  refused without ever being handed on, and `core.version` reports the composed
  table (and still reports only the core's own without a host).
- `integration/TestCoreDaemonServesThePrivateChannel` now proves over the real
  private channel that the daemon _serves_ the table: `device.createKey` returns
  a real ed25519 key and CSR, a published peer method with no configured service
  comes back with the host's own `p2p.service_unconfigured`, an inbound
  `runtime.connect` is `p2p.invalid_operation`, and `nope.nope` is
  `p2p.invalid_operation` rather than a payload error.
- macOS: `go build`, `go vet` (native and `GOOS=windows`), every unit package, and
  the full `integration` suite (262 s) pass.
- Windows (Go 1.26.4): `go build`, `go vet`, every unit package and the three
  real-daemon tests pass (5 s), and the 12-test integration subset passes (256 s).
  The two `RealDSH` diagnostics are excluded there for the environment reason
  recorded last round: that machine's harness checkout cannot start `dsh web`.

## Measured, and deliberately not decided here

3.7's headline verification — "a peer connection completes with no Electron
process running" — needs the daemon to talk to a coordinator, and it cannot yet:
`helper.Host.configure` builds its client with `controlplane.New(endpoints, nil)`,
i.e. system roots only, so a self-hosted coordinator with a self-signed TLS
certificate is refused at the handshake. I measured this instead of assuming it:
a probe against the integration fixture's coordinator returned
`p2p.server_unavailable`. The fixture certificate is deliberately not a CA, so it
also cannot stand in as the catalog's identity `certificate`, and the shell holds
no TLS chain to send — its `service.certificate` is the coordinator's _identity_
CA.

This predates the change (`dshker-peer` behaves identically), so it is a finding
rather than a regression. It needs a decision, not a rushed patch: accept the
coordinator's TLS CA in `service.configure` (coherent, but a payload-shape change
and therefore a table version bump), or give `dshkerd` an explicit trust root
such as `--roots <absolute PEM path>`, which the headless `serve` entry point in
P5 needs anyway. Both are recorded under 3.7.
