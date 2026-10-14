## Purpose

Keep long-lived desktop and headless peer subscriptions recoverable by verifying the actual signal socket separately from device presence, without restarting local DSH or substituting another transport.

## ADDED Requirements

### Requirement: Verify the subscribed channel

The peer SHALL require an actual WebSocket pong within a bounded deadline to keep a signal subscription healthy. HTTPS presence success alone SHALL NOT satisfy this requirement. Idle but responsive subscriptions SHALL remain available on macOS, Windows and headless clients.

#### Scenario: Healthy idle subscription

- **WHEN** a subscription has no application events but responds to ping and accepts presence heartbeats
- **THEN** it remains subscribed and can deliver subsequent signal events

#### Scenario: Presence works while the socket is unresponsive

- **WHEN** HTTPS presence succeeds but the subscribed socket does not answer ping by the deadline
- **THEN** the subscription closes with `p2p.server_unavailable` and becomes eligible for the existing reconnect policy

### Requirement: Bound cancellation and preserve failure ownership

Cancelling or closing a subscription SHALL stop its readers and health checks without waiting for another heartbeat interval. Presence rejection SHALL retain its typed error. A coordinator's explicit superseded reason SHALL continue to suppress competing automatic re-subscriptions. The repair SHALL NOT start or restart DSH, change identities, or substitute a server or relay.

#### Scenario: Close during a pending health check

- **WHEN** the owner closes a subscription with a pending ping
- **THEN** the check and read loop terminate promptly and no later heartbeat is sent

#### Scenario: Explicit presence refusal

- **WHEN** the coordinator refuses the device heartbeat
- **THEN** the subscription terminates with the coordinator's typed refusal rather than remaining healthy

#### Scenario: Coordinator supersedes this subscription

- **WHEN** the coordinator closes the socket with its explicit superseded reason
- **THEN** that reason remains available to the supervisor and is not overwritten by the health check cancellation

#### Scenario: Superseded during subscription admission

- **WHEN** an initial or replacement subscription receives the coordinator's superseded refusal before health admission completes
- **THEN** automatic replacement stops rather than displacing the newer subscription

### Requirement: Bound event overload explicitly

The subscription SHALL keep event storage bounded. A full event queue SHALL terminate the subscription with `p2p.signal_limit` instead of blocking control-frame processing, silently discarding an event while continuing, or misreporting an unresponsive server.

#### Scenario: Consumer does not drain queued events

- **WHEN** an initial or established subscription receives more events than its bounded queue can hold
- **THEN** it terminates with `p2p.signal_limit` and releases its socket and health tasks
