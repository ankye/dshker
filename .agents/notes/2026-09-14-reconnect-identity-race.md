# A reconnect used to fail the instant it came up

Date: 2026-09-14

## How it was found

A new stress test (`integration/reconnect_stability_test.go`) connects and
disconnects one pair 20 times, asserting that the address never changes, that the
peer never stops answering, and that the cycles accumulate neither listeners nor
goroutines. It failed at a random cycle (3, 5, 6, 9, 10, 13) in roughly half of
all runs, always the same way:

```
A: [punching] [starting-runtime udp] [failed p2p.direct_closed udp]
B: [punching] [failed p2p.direct_unavailable]
```

The same test run against the commit before the stable-address work failed 5 of 5
times, so this is not a regression from that change — it is a long-standing
intermittent failure that only a repeated-reconnect test exposes.

## The diagnosis

`WaitReady` returns a hardcoded `p2p.direct_unavailable` whenever the transport
context ends, which hides why the transport actually died. Instrumenting `fail()`
with the error and the attempt id gave the real first event for a failing attempt:

```
FAIL-TRACE <device> <attempt> p2p.identity_not_verified   <- first event
FAIL-TRACE <device> <attempt> p2p.direct_closed           <- the peer follows
```

`p2p.identity_not_verified` came from the data-channel message path:

```go
select {
case <-transport.ready:
default:
    transport.fail(errors.New("p2p.identity_not_verified"))
}
```

A message that arrives between the channel opening and the identity check
finishing killed an otherwise healthy connection. On a warm reconnect the peer's
first frame — the runtime handshake — lands inside that window, so both sides tore
down a session that had just come up. On a cold first connection the same frame
arrives later and nothing happens, which is why the existing tests, and a real DSH
whose startup dominates the timing, never caught it.

## The fix

The message path now waits for the identity check instead of failing:

```go
select {
case <-transport.ready:
case <-transport.ctx.Done():
    return
}
```

The security property is unchanged: bytes are still only delivered after the DTLS
fingerprint has been verified, and a failed check still ends the transport, which
drops the waiting message rather than forwarding it. `Send` keeps returning
`p2p.identity_not_verified`, so a caller still cannot send before verification.

## Verification

- Before: 2 of 5 runs failed on the working tree, 5 of 5 at the parent commit.
  After: 10 of 10 runs pass on macOS, 5 of 5 on Windows, each logging
  `20 reconnects, one stable address, goroutines 113..128 -> 24`.
- Full macOS suite green, including integration (235s). Windows build, vet, the
  three touched packages and the same stress test all pass. The only Windows
  failures remain the two `RealDSH` diagnostics, which cannot start the CLI there.

## Files

- `networking/internal/peer/transport.go` (the fix)
- `networking/integration/reconnect_stability_test.go` (new stress test)
