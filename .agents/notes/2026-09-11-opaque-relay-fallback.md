# Opaque TURN relay fallback: user decision, cross-repo implementation, verification (2026-09-11)

User decision on the deployed-network fabric: the office ZeroTier data plane drops raw
cross-host UDP (ICMP/TCP pass, ICE direct fails honestly with `p2p.direct_unavailable`).
Per direct instruction ("加服务器中转" + "文档约定也要修改"), the previously documented
no-relay constraint is replaced by: **direct ICE first; fall back to an opaque relay on the
deployment server when no direct path exists; report `p2p.direct_unavailable` only when both
fail.** All docs/gates that said "no relay" were rewritten in the same pass (21 places, EN/ZH
pairs, OpenSpec proposal/spec/tasks, preflight tooling + tests, test-gate JSON, server repo).

## What landed (cross-repo)

- **dshker-server**: pion/turn v5.1.1 serves Binding + TURN on one UDP socket;
  `turnSharedSecret` (`openssl rand -hex 32`, >=32 bytes) enables the relay;
  device-scoped TURN-REST credentials (`<unix-expiry>:<deviceID>`, HMAC-SHA1, 24h, never
  persisted) are issued per device at `POST /v1/turn-credentials`. Config keeps strict core
  validation while relay fields are optional (older config files keep working); short/missing
  secret answers `p2p.relay_unconfigured`. Allocation ports come from the OS ephemeral range
  (no fixed-range knob in pion/turn v5).
- **dsh-launcher**: `controlplane.Client.TurnCredentials` fetches the credential set; the
  peersession manager caches it once per manager lifetime and degrades gracefully (a 404 or
  relay-unconfigured response leaves the session on the direct path only); `internal/peer`
  builds the ICE server list as STUN direct + TURN relay entries
  (`iceServersFor`, CredentialType password).
- **Verification (local)**: 4 server relay tests pass (credential shape + TURNREST auth
  handler accept/expired/malformed; two turn clients relaying A<->B datagrams through
  127.0.0.1; tampered-credential allocation refused; disabled-relay refusal). Client unit
  tests pass (iceServersFor direct-only / with-relay; strict creds endpoint + malformed
  response refusal). Full integration suite green against the new server binary with the
  fixture enabling the relay config (old binary + new client degrades to direct-only).
  Cross-machine drive-through still waits on the user redeploying the new dshker-server to
  my.ffkey.com and opening UDP 3478 + the OS ephemeral range.

## Test-flake fix (pre-existing, found while verifying)

`TestTwoPeerProcessLoadAndReconnect` was rate-sensitive: its rapid reconnect loop could burst
over the coordinator admission budget (20 req/s per source IP, a DDoS guard) and flake with
`p2p.rate_limited` — reproduced on the untouch commit (2 pass / 2 fail back-to-back on this
machine). The loop is now paced at 150ms per round (fixture-only, product untouched) and runs
3/3 green; the production limiter semantics are unchanged.

## Two relay-introduction bugs found in full-suite runs (both fixed)

1. **Re-entrant manager lock deadlock**: `Manager.start` already holds `manager.mu`, and the
   new `turnEndpoints` re-acquired it for its credential cache — Go mutexes are not
   re-entrant, so any session start with a pending credential fetch self-deadlocked and
   froze the whole manager (mac integration 16m timeout; win run6 15m timeout; both reproduced
   deterministically on the same callsite stack `start → turnEndpoints → Lock`). Fix: fetch
   relay credentials **before** taking the manager lock (fetch is a slow network call that must
   never run under the lock), cache write guarded by a first-writer-wins double-check inside
   the lock. Fixed on both platforms; the deadlocked suites turn green.

2. **SDP validation rejected relay candidates**: `validateSDP` (no-relay era guard) refused
   any SDP containing a `candidate` of type relay with `p2p.direct_unavailable`. With the
   relay enabled, every ICE offer/answer legitimately carries relay candidates, so the first
   `Connect` failed immediately. Fix: candidates must still ride UDP, but relay type is now
   legal — ICE keeps preferring the direct host/reflexive pair, and `State.Path` assertions
   (udp, non-relay selected pair) still hold because ICE only falls back to the relay when
   no direct path exists.

Also: occasional full-suite flake in `TestManagerNetworkRevocationRealDSH` (3.8s
`p2p.direct_closed` right after Establish, ready=true) is **not** reproduced in isolation
(3/3), combined (`TestManagerRealDSH|...Revocation`, green) or on Windows (RUN6=0) — it is
an environment-cold-start flake of the same family as the LoadAndReconnect one, tracked, not
yet root-caused to code.
