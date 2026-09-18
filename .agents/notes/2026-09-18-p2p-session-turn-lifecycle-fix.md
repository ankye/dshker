# P2P session and TURN lifecycle fix — 2026-09-18

## Scope

Pure defect repair in the existing self-hosted P2P implementation. No renderer,
IPC, coordinator API, protocol field, fallback service, or product feature was
added.

## Defects

1. A superseded peer session could finish after its replacement had attached a
   new mux to the pair-owned Endpoint. Its unconditional `Detach` then removed
   the replacement mux while the new session still reported `ready`.
2. The first TURN credential result, including an error, was cached for the
   whole Manager lifetime. Transient failures therefore disabled relay until
   restart, and successful 24-hour TURN REST credentials were reused after
   expiry.

## Repair

- `Endpoint.Detach` now requires the exact owning `*peer.Mux` and clears the
  attachment only when it still matches.
- Session cleanup passes its own mux, so stale cleanup is a no-op after
  replacement.
- TURN credentials use the existing `<unix-expiry>:<deviceId>` username as the
  strict expiry and identity source. Fresh credentials are cached only outside
  a five-minute refresh window; failed or invalid responses are not cached.
- Concurrent refresh callers share one coordinator request. A later attempt can
  retry a failed refresh.

## Regression coverage

- `TestStaleDetachPreservesReplacement`
- `TestTurnCredentialsCacheOnlyFreshDeviceCredentials`
- `TestTurnCredentialsRefreshExpiredCache`
- `TestTurnCredentialFetchFailureIsRetried`
- `TestTurnCredentialRefreshIsSingleFlight`
- `TestTurnCredentialExpiryRejectsMalformedForeignAndStaleValues`
- `TestManagersAlternateOfflineAndRecover` (four real offline/online cycles per
  device, nine unique attempts, stable per-dialer gateway, direct UDP and
  runtime probes under `-race`)

The existing multi-peer matrix also passed under `-race`: both-direction
replacement, both Manager role assignments (20 reconnects each), 30 rapid
post-load reconnects, signaling loss/re-subscription, and abrupt peer loss with
recovery/revocation.

Three integration diagnostics failed identically on an unmodified HEAD
snapshot. `TestManagerNetworkRevocationRealDSH` and `TestManagerRealDSH` omitted
the required account-scoped presence setup and therefore failed in coordinator
`Begin` before TURN/session setup. `TestCoreDaemonCompletesAPeerConnection`
expected an answered session to emit renderer `ready`, although the current
direction contract intentionally suppresses responder UI state. Their fixtures
now set the explicit account, and responder cleanup is asserted through the
public session capability (`p2p.not_connected`) instead of a forbidden UI
event. The initiator state, direct path, gateway, runtime and revocation checks
remain intact.

The selected Harness checkout also contained ignored `lib/` output older than
its source; that build announced a URL and then exited on an obsolete HMR path.
Running the Harness repository's own `pnpm build` regenerated ignored artifacts
without modifying tracked Harness files. `startRealDSH` now treats the full
HTTP/cookie/websocket probe, not a printed URL, as readiness so an exited or
half-started Harness cannot produce a false-positive fixture.

After those test-contract repairs, the complete explicit-input command
`go test -race -count=1 -timeout=15m ./...` passed, including the 501.615-second
integration package and every internal package.

Physical cross-machine, packaged, and relay-path acceptance remain separate
OpenSpec gates and are not claimed by these focused tests.
