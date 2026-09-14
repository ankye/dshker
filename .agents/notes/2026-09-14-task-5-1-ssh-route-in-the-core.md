# Task 5.1, client half — the SSH route in the core

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 5.1)

## What landed

`internal/remoteroute` owns the outbound half of the SSH route: the platform
OpenSSH pair, the descriptor transfer, the two loopback forwards, the broker call,
and the loopback-only validation of the address that comes back. It is the Go half
of `electron/main/remote/{openssh,peer-broker}.ts`, ported rule for rule:

- `buildScpArguments` and `buildSshForwardArguments` produce the shell's exact
  argument order: `-q -B -o StrictHostKeyChecking=yes -P <port> user@host:<path>`
  and `-N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o
StrictHostKeyChecking=yes -p <port> -L 127.0.0.1:<local>:127.0.0.1:<remote>
user@host`. Batch mode and exit-on-forward-failure are what keep a refused
  tunnel a failure rather than an invisible password prompt.
- The peer descriptor is parsed strictly — exactly `format`, `version`,
  `instanceId`, `port`, `secret` — because it names the port and the bearer
  secret this route will trust.
- The broker answer must be exactly `{version, url}` with version 1, and the URL
  must be an explicit loopback http(s) origin with a port. Anything else is
  `remote.peer_protocol_invalid`: a peer that answers with a LAN address is
  refused rather than tunnelled, which is the invariant task 5.2 asks to keep.
- Every failure keeps its own code: `remote.ssh_unavailable`,
  `remote.ssh_authentication_failed` (from the OpenSSH diagnostic, so an
  authentication problem is never reported as a missing peer),
  `remote.peer_unavailable`, `remote.peer_authentication_failed`,
  `remote.peer_protocol_invalid`, `remote.tunnel_failed`, `remote.connection_busy`
  and `remote.not_connected`.
- A forward is spawned in its own process group on POSIX and stopped through
  `taskkill /t` on Windows; a forward that dies after the address was handed out
  retires its generation and tells the caller instead of leaving a dead address in
  the renderer.

`Route` owns the live generations keyed by connection id, so a connection now
survives a renderer reload and dies with the core. The core publishes
`remote.connect`, `remote.disconnect` and `remote.status`, `remote` joined the
declared refusal families, and `cmd/dshkerd` creates one route with a deferred
`Shutdown` in both its parent-driven and headless modes.

## Evidence

- `internal/remoteroute`: 16 cases. The argument lists are pinned token for token;
  the descriptor and the broker answer are refused for a missing field, an extra
  field, a wrong format, a wrong version, a bad port and a non-string URL; the URL
  parser accepts three loopback spellings and refuses a LAN address, a
  host without a port, a `file:` URL and a malformed one; the SSH diagnostic
  classifier separates authentication from everything else; a full generation runs
  end to end over injected seams and asserts both forward argument lists, the
  broker port and secret, the mapped URL and that both forwards were stopped; and
  each failure mode returns its own code with nothing left running.
- `internal/core`: four cases over the private channel — the refusal for a core
  with no route, a connect/status/disconnect round trip, the authentication
  refusal crossing unchanged, and strictly decoded payloads.
- `integration/remote_route_test.go`: the real daemon. A connection that was never
  opened reports `present:false`, disconnecting it is `remote.not_connected`, and
  a route whose OpenSSH client cannot exist is `remote.ssh_unavailable`.
- `go build`, `go vet` (host and `GOOS=windows`) and the Go unit suite pass.

## What is left of 5.1 and 5.2

The **broker** (the server side: the loopback endpoint that hands a remote peer one
DSH session, plus the descriptor it publishes) is still the shell's, and the shell
still holds the connection catalog and the connection UI. 5.2's relay invariant and
5.3's deletion of `electron/main/remote` follow the shell switch. A real route
between two machines is the verification this half still owes.
