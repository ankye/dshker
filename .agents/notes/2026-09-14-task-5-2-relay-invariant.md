# Task 5.2 — the loopback rule and the opaque relay

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 5.2)

## Two invariants, two kinds of proof

**The resolved URL must be an explicit loopback origin.** `remoteroute.ParseRuntimeURL`
accepts `http`/`https` with a host of `127.0.0.1`, `localhost` or `::1` and a
port in range, and refuses everything else with `remote.peer_protocol_invalid`.
Its table covers a LAN address, a host without a port, port zero, a `file:` URL
and a malformed one. A peer that answers with something else therefore never gets
a tunnel, which is what keeps the session on the machine even if the remote side
is hostile or misconfigured.

**The relay must carry only ciphertext.** The transport's relayed path is proven
by `internal/peer/relay_invariant_test.go`, which is the interesting half:

- a real TURN server (`pion/turn/v5`) runs in-test on a socket wrapped in a
  recorder, so every datagram the relay receives is kept;
- `TransportOptions.RelayOnly` pins ICE to `ICETransportPolicyRelay`, so a
  session cannot complete any other way — and the test asserts that both peers
  selected a pair whose **local and remote** candidate types are `relay`, because
  a host candidate would mean the session escaped the relay and the recording
  would prove nothing;
- a known plaintext marker is sent over the data channel and received intact;
- every recorded datagram is then searched for that marker. There is traffic, and
  none of it is the marker: what the relay forwarded was DTLS records.

The option exists for exactly this verification. Its comment says so, and the
product leaves it off: a direct UDP path is preferred and the relay is the
fallback, which is the behaviour the transport tests already pinned.

## Evidence

- `go test ./internal/peer/ -run RelayCarriesOnlyCiphertext` passes (~2 s).
- `internal/remoteroute`'s URL table passes in the package suite.
- `go vet` and the full unit suite pass on macOS, and `GOOS=windows go vet`
  typechecks the new option on the other platform.
