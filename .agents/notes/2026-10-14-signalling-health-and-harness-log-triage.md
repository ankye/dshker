# Long-running signal health and external Harness log ownership

## Observed

Installed Launcher 0.1.87 remained alive with its selected Harness d743267388641bc76f17c45ce8b4c231aed1d32c. Core diagnostics recorded coordinator interruptions and later repaired/connected events. The user confirmed Win↔Mac connectivity recovered. This does not prove a particular half-open socket caused that incident.

## Decision

`controlplane.Signals` previously used HTTPS presence without verifying the upgraded socket. Add bounded Ping/Pong under the same lifecycle context and terminate failed subscriptions for the existing reconnect supervisor. Keep specific refusal/superseded causes, join cancellation, and do not involve local Harness lifecycle, credentials, server substitution or relay selection. OpenSpec: `repair-signalling-channel-health`.

Independent review found two adjacent hazards: a full 32-event queue blocked pong reads, and a pending ping could publish cancellation before the reader finalized a superseded close. Overflow now ends explicitly as `p2p.signal_limit`, with already admitted queue entries preserved; completion is published only after read-side classification. An explicit superseded refusal before readiness or during replacement admission stops automatic replacement. A later explicit `ReconnectSignals` still works and remains owned by the manager context, not the finished RPC context.

## Other log errors

- Compaction selected an old durable request's `anthropic/claude-opus-5`, excluded from the current custom provider catalog. Ordinary requests now select `claude-opus-5-5`. Adding an invented model alias, using AgentOptions instead of the UI-selected assembled route, or rewriting session history is not a repair. The external Harness needs pressure compaction to use the exact newly prepared request and its frozen adapter metadata.
- `spill-policy` requests image pricing, but the external pi-ai adapter declares no image calculator. Only its owning adapter can provide one; duplicate adapter registration or a monkey patch is not acceptable. Do not disable retention or fabricate image token costs to silence the warning. Upstream/provider work requires a separately maintained source repair and exact model-pricing policy.
- HTTP `ECONNRESET` records lack request/channel context. They establish a reset, not a process crash. Do not blanket suppress reset errors. Missing workspace warnings and macOS containment limits are not repaired by inventing directories or disabling supervision.

## Acceptance limits

At the source-validation checkpoint, the user chose to finish P2P only; no Harness checkout, profile or installed application was modified or restarted, and no local installer was packaged. The later requested stable release is recorded in `2026-10-14-release-v0.1.88.md`.

Validated on 2026-10-14:

- Default test-integrity verification: 17 new top-level real TLS/WebSocket tests (20 including malformed-message subtests), no failures; generated output `.run/signalling-channel-health/go-test.jsonl`. No clock, adapter, transport or production-configuration test hook replaces the path.
- `go test -race ./internal/controlplane ./internal/peersession -count=1`: both full packages pass, including existing reconnect regressions.
- `go test -race ./internal/helper ./cmd/dshkerd -run 'Test(RepairSignals|ServeRepairsSignals)' -count=1 -v`: five focused regression tests pass.
- `GOOS=windows GOARCH=amd64 go vet ./internal/controlplane ./internal/peersession ./internal/helper ./cmd/dshkerd` and the equivalent Linux command pass. This is compile/static evidence, not Windows execution.
- Launcher environment, type, architecture and template-service checks pass; parent desktop app validator passes. Formatting, OpenSpec strict validation, diff whitespace and the 1000-line source-size gate pass.

These checks validate the source repair, not installed-build, production-coordinator soak or physical Win↔Mac acceptance. Deployment remains a separate gate. Test refusal expectations preserve specific decoder errors (`p2p.invalid_fields`), not a less precise generic error.
