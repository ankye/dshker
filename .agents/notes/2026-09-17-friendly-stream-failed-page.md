# 2026-09-17 – Friendly error page when the gateway proxy fails (p2p.stream_failed)

## Problem

When a firewall (macOS) drops UDP between the two computers, the P2P connection
reaches "ready" (ICE establishes, the hello exchange completes, the probe passes)
but the transport dies moments later when ICE keepalives stop flowing. The
webview then loads the gateway URL and gets a raw HTTP 502 with body
`p2p.stream_failed` — a bare error code that tells the user nothing about what
to check.

## Fix

`errorpage.go` — new file returning a bilingual (zh-CN / en) HTML page with
troubleshooting steps. The proxy ErrorHandler in `proxy.go` now serves this
page instead of the bare text code.

Also added `p2p.stream_failed` to the `noDirectPath` category in
`i18n.refusals.ts` (defensive — the code is HTTP-502 text, not a connection
status code) and documented it in `docs/p2p-connections.md`.

## Files

- `networking/internal/runtimebridge/errorpage.go` — new, the error page.
- `networking/internal/runtimebridge/proxy.go` — ErrorHandler uses the page.
- `src/app/shared/i18n/i18n.refusals.ts` — `p2p.stream_failed` maps to
  `noDirectPath`.
- `docs/p2p-connections.md` — row in the Connecting troubleshooting table.
- `CHANGELOG.md` — 0.1.58 entry.
