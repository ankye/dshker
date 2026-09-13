# A stable gateway URL across reconnects

Date: 2026-09-13

## The problem

The gateway that exposes a peer's DSH Web on loopback was created per session:
`OpenBrowser` allocated `net.Listen("tcp4", "127.0.0.1:0")` and the listener was
owned by the session context. Every reconnect therefore produced a new random
port and a new URL. Inside the app that was invisible — main simply handed the
new address to the guest view — but a real browser tab left open on the old
address went white (the classic symptom: `net::ERR_CONNECTION_REFUSED`). With
automatic reconnect now in place (`PeerAutoConnect`), a tab would be broken
after every network blip.

Reusing the _same_ port number would not fix it either: a fixed port collides
between pairs and with other software. The port has to stop being tied to the
session, not become constant.

## The design

- `runtimebridge.Endpoint` sits between the pair and its gateway. It holds the
  current mux and binding and is replaced as often as the session is rebuilt;
  `Replace`, `Detach` and `Close` are its whole surface.
- `OpenBrowserEndpoint` owns a listener for the endpoint's lifetime and re-reads
  the destination on every dial. `ServeTargetEndpoint` does the same for the
  non-browser direction, using a replaceable `peer.Listener`.
- `peer.Listener` no longer reports a dead mux as a fatal `Accept` error. Such an
  error makes `http.Server.Serve` close the listener and return, which would have
  forced every caller to know how to restart serving. `Accept` now waits for the
  next `Replace`, exactly like the browser gateway waits for the next session.
- `Establish` takes two contexts: the session's (its transport, its attempt) and
  the gateway's (the manager's lifetime). Attaching the gateway to the session
  context is what closed the port on every drop.
- `Manager` keeps `endpoints[pairID]`, so a pair's gateway survives any number of
  sessions. `revoke` and `RevokeNetwork` are the only paths that close one, plus
  `Manager.Close`.

## Decision: option B

Two behaviours were possible for an explicit `Disconnect`. Option A closed the
gateway (the old URL dies at once, matching the previous security property) and
option B keeps it, so the address is stable even across a manual disconnect. The
user chose B. The property that mattered is preserved: a detached gateway still
binds its port but proxies nothing — every request fails with a non-2xx and the
peer runtime is never touched (`TestDetachedGatewayServesNoRuntimeContent`).
`assertGatewayDetached` in the integration suite replaced the old
`assertGatewayClosed` for that scenario; `Manager.Close` still releases the port
and keeps the original assertion.

## Defects found while verifying

1. `Listener.Close` closed a channel twice (endpoint and `http.Server` both close
   it) and panicked in a real revocation run. Now idempotent.
2. `defer endpoint.Close()` sat inside the long-running `receive` loop, so a
   revoked gateway was only released when the manager shut down. Extracted
   `revoke(pairID)` and closed immediately, before the loop's early `continue`.
3. `RevokeNetwork` never closed endpoints at all, so a deleted network's gateway
   stayed reachable.
4. `OpenBrowserEndpoint` never set `onClose`, so `Endpoint.Close` could not
   release the browser port.
5. A reconnect reported `endpoint.Binding().URL` as the connection URL — that is
   the _peer's_ loopback address, meaningless on this machine, and it sent callers
   to the other machine's port. `Endpoint.LocalURL` now records the gateway's own
   address.
6. The reverse proxy captured the destination URL at creation, so after the peer's
   DSH restarted (new port and token) it kept forwarding to the dead runtime.
   Both addresses are now resolved per request.
7. The stable URL also pinned the _old_ token, so a restarting runtime broke an
   open tab. A request that carries a token is now forwarded with the current one;
   a cookie-only request is untouched so the auth exchange cannot loop.
8. `local.RawQuery` was written after `serve` had started, racing with readers.

## Verification

- macOS: `go test ./...` all green, including integration (208s) and `-race` on
  `runtimebridge`, `peer` and `peersession`. TS gates unchanged and green
  (format, type-check, architecture, 1239 tests).
- Windows: build, vet and the three touched packages pass; integration passes
  except the two `RealDSH` diagnostics, which cannot run on that machine because
  its harness checkout is missing `@deepseek-ai/dsh-http-proxy` (`ERR_MODULE_NOT_FOUND`
  when the CLI is started by hand).
- Cross-host drive re-proved in both directions over the live coordinator; the new
  `mac serve` / `win connect` pair in `live-drive` is what allowed win→mac.

## Files

- `networking/internal/runtimebridge/endpoint.go` (new) and `proxy.go`
- `networking/internal/runtimebridge/handshake.go`
- `networking/internal/peer/conn.go` (replaceable listener)
- `networking/internal/peersession/manager.go`, `network_revocation.go`
- Tests: `endpoint_test.go`, `listener_test.go`, `endpoint_lifetime_test.go`,
  `runtime_session_test.go` (integration), `proxy_test.go`, `manager_test.go`
- `networking/tools/live-drive/main.go` (`mac serve` / `win connect`)
