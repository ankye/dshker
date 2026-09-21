# Remote connection state consistency

## Scope and authority

This follow-up repairs four previously identified inconsistencies without introducing another transport or guessing missing state:

- A changed local SSH key path is an authentication-parameter change, just like changing the host, port, or user. A connected or testing record cannot accept that edit. Saving it while disconnected invalidates the previous one-shot test; the new path applies only to a new test or connection. Neither the renderer nor catalog reads or transfers private-key contents.
- Repaired P2P coordination signaling belongs to the long-lived peer-session manager. The initiating RPC's deadline may bound its own operation but cannot own the new subscription after that RPC returns. Concurrent repairs must not leave an orphan subscription or silently replace an already healthy one.
- The account/network view and its actions must have the same explicit service identity. Changing the selected `serviceId` may not show the former service's user/networks while issuing actions against the new service.
- A paired computer that can be connected is **available**, not failed. Its add-tab indicator stays neutral/accent; red is reserved for an actual failure, revoked authorization, or confirmed offline state. Labels remain available so color is never the only signal.

## Boundaries

These changes do not restore lost credentials by inference, auto-connect an SSH record after an edit, fall back to SSH when P2P signaling is unavailable, or change the server-side pairing model. Desktop autostart process ownership is a separate issue and is not covered by this note.

## Focused verification

- `go test -race ./internal/peersession -count=1` from `networking/` passed, including signaling ownership and concurrent repair cases.
- `npm test -- --run electron/main/remote/service.test.ts src/app/shell/tests/P2PNetworkAccountPanel.test.ts src/app/shell/tests/RuntimeTabsPanel.test.ts` passed (3 files, 21 tests).

These focused checks do not stand in for full repository checks, packaged runtime verification, or two-machine reconnection acceptance. Record any remaining environment-dependent checks separately before delivery.
