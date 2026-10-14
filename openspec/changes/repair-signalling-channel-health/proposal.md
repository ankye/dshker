## Why

Users leave Mac and Windows peers running for hours and need reconnects to work without restarting DSH. The coordinator's HTTPS presence heartbeat does not verify the separate WebSocket signal path, so a half-open subscription can remain marked healthy.

## What Changes

- Verify the actual signal socket with bounded WebSocket ping/pong, independently of HTTPS presence.
- Close an unresponsive subscription and preserve its typed failure for the existing reconnect supervisor.
- End an overfull event queue with an explicit overload failure rather than blocking pong processing, and suppress automatic retries of an explicitly superseded initial/replacement subscription.
- Exercise healthy idle sockets, missing pong, presence rejection and cancellation against real local TLS/WebSocket endpoints.

The desired outcome is a detectable, recoverable signal failure, not a guarantee that an unavailable coordinator can be reached. Non-goals: substitute servers, implicit relay, account/token changes, automatic DSH start, changing Harness model selection or silencing Harness logs.

## Capabilities

### New Capabilities

- `signalling-channel-health`: bounded liveness checks and cancellation of the actual subscribed WebSocket.

### Modified Capabilities

None.

## Impact

Only this repository's `networking/internal/controlplane` and `networking/internal/peersession` implementations and tests change. No renderer/IPC, persisted data, dependency or server protocol change is required. DSH compaction/image-pricing errors are owned by the selected external Harness/provider configuration and are tracked separately; they must not be presented as fixed by this socket repair.
