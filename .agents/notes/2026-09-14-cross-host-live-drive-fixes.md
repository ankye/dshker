# Cross-host live-drive: relay path acceptance and signal expiry

Date: 2026-09-12/14 session (live verification window)

## Context

The cross-host live-drive verification (mac driving the Windows host's DSH Web
through the P2P stack) never got past `punching`: both sides reported
`p2p.direct_unavailable` within seconds, even though the bare TURN relay data
plane (`relaycheck`, later deleted) had already proven both directions through
`my.ffkey.com:8443`.

## Root causes (two independent bugs)

1. **`Transport.Path()` rejected relayed candidate pairs.** `validateSDP`
    explicitly allowed relay candidates and `iceServersFor` added the TURN
    server, but `Path()` returned `p2p.direct_unavailable` for any selected
    pair with a `relay` local or remote candidate. A session that had just
    connected through the relay was torn down at the first `Path()` call in
    `channel.OnOpen`. Fix: only the UDP transport requirement is enforced; a
    relayed pair is a legal selected path (ICE still prefers direct pairs).

2. **Signals carried the lease expiry as `ExpiresAt`.** `Signal.Verify`
    accepts `ExpiresAt` only within `(now, now+60s]`, but `gather()` filled it
    with `transport.lease.ExpiresAt` (hours ahead), so every offer/answer was
    rejected by the peer as `p2p.signal_expired` before ICE ever started.
    Fix: `protocol.SignalExpiry(issuedAt)` issues a signal-scoped expiry
    (validity minus a 15s clock-skew margin); `gather()` uses it. Regression
    test `TestSignalExpiry` pins the window arithmetic.

## Verification (live, mac ⇄ Windows over the deployment server)

- mac `live-drive mac connect` → `A-CONNECTED`, `A-PATH udp host host`,
  `A-GATEWAY http://127.0.0.1:<port>/?token=…`, `A-PROBE 200` with the DSH
  Web HTML body and one session cookie — mac drove the Windows DSH Web end
  to end through the tunnel.
- Both sides gathered TURN relay candidates (`124.223.103.213:8xxx-9xxx`);
  the selected pair was direct because both hosts sit on the same VPN
  subnet. The relay data plane itself was proven separately (relaycheck
  `RELAY-OK` both directions; server tcpdump showed STUN + TURN Allocate +
  relayed data on the pinned 8000-9999 port range).
- live-drive `probe()` now uses a cookie jar: the DSH Web auth flow is a
  303 + `dsh-session`-style cookie exchange, so a jar-less client always
  ended on 401 even when the tunnel was healthy.
- Windows DSH Web must run with a captured launch token; the runtime URL in
  `state.json` (`runtimeUrl`) must be `http://127.0.0.1:3080/?token=…` —
  `Binding.Endpoint()` rejects URLs without exactly one `token` query.

## Test evidence

- mac: `go test ./... -count=1` — all packages pass (integration 188s).
- win: same suite — all packages pass except one `TestStressConcurrentStoreOperations`
  run that hit a Windows rename race (`Access is denied` on
  `credentials.json.tmp`), which passed 5/5 on immediate retry
  (`go test ./internal/secret/ -count=5`).

## Files

- `networking/internal/peer/transport.go` — `Path()` accepts relay pairs.
- `networking/internal/peer/transport_test.go` — direct-pair test asserts UDP only.
- `networking/internal/peer/negotiation.go` — `gather()` uses `SignalExpiry`.
- `networking/internal/protocol/signal.go` — `SignalValidity`, `SignalExpiry`.
- `networking/internal/protocol/protocol_test.go` — `TestSignalExpiry`.
- `networking/tools/live-drive/main.go` — probe with cookie jar.
- Deleted: `networking/cmd/relaycheck/` (temporary verification tool), stray
  `networking/relaycheck` binary.
