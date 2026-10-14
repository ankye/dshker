## Context

See proposal.md. `controlplane.Signals` already has one lifecycle context, a reader and a 10-second presence loop. `peersession` reconnects subscriptions after `Done`, but HTTPS presence can succeed while a socket is half-open. The installed log establishes coordinator interruptions, not proof of this specific half-open path.

## Goals / Non-Goals

Goals: bounded socket verification, preserved typed refusal, quiescent close. Non-goals are listed in the proposal. No new IPC, storage, directory, Git, process or model-provider ownership is introduced.

## Decisions

- Use the existing WebSocket dependency's ping/pong implementation on the subscribed connection. Presence uses HTTPS for authorization/presence and cannot replace this check. Application messages are not required during idle periods.
- Share the subscription's lifecycle context; bound each ping to 5 seconds and keep the existing 10-second cadence. The single initial check must complete before readiness is published. Publish subscription completion only after the reader finalizes its close reason; a pending ping observing socket closure must not race the supervisor's superseded decision.
- Cancel and close the failed socket. Reuse the existing reconnect supervisor rather than adding a second retry owner. The supervisor's existing backoff and explicit superseded handling remain unchanged. Health checks cannot call the Harness runtime.
- Treat a typed superseded refusal during replacement admission as terminal for that automatic supervisor, matching its established-subscription behavior. Explicit reconnect remains a separate operation.
- Keep the 32-event limit but never block control-frame reads on event delivery. An overfull queue ends the subscription with `p2p.signal_limit`; it does not discard an event and continue or allocate unbounded storage.
- Test through real TLS HTTP/WebSocket sockets, including a server that accepts HTTPS while never reading/responding on its upgraded socket. Avoid production test configuration or shortened production timeouts.

## Risks / Trade-offs

- Packet loss or long server stalls can trigger a reconnect after a missed pong → retain bounded backoff; never mark unverified sockets healthy.
- A slow event consumer can exhaust the bounded queue → fail explicitly with overload rather than letting blocked pong processing produce a false network failure. Real burst tests cover both admission and established subscriptions.
- Client repair cannot cure coordinator downtime → report typed failure instead of promising reachability.
- Harness warnings have separate owners → do not patch a clean managed checkout or claim this change repairs missing image pricing or obsolete compaction model references.

## Migration Plan

Ship as normal source changes in the next Launcher/core build; no data migration. Existing active processes are unchanged until an explicitly scheduled restart. Reverting the code requires no persisted-data rollback.
