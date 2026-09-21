# Network account visual density — 2026-09-20

## Review finding

The Network & account route stacked a route surface, a My network surface, an
account card, a bordered network picker and a bordered device table. The repeated
rectangles made every level look equally important and created the impression of
an unfinished wireframe.

## Repair

- Keep one primary route surface and use spacing plus one-pixel separators for
  identity, selected-network summary and device rows.
- Remove the repeated outer card border/background from the Network & account
  composition, the inner account workspace, the network selector block and the
  device-directory frame.
- Preserve the data hierarchy and controls: network/device names, IDs, status,
  refresh, create, manage, remove, copy and leave remain unchanged.

## Validation

`npm test -- --run src/app/shell/tests/P2PAccountPanel.test.ts
src/app/shell/tests/P2PNetworkAccountPanel.test.ts
src/app/shell/tests/P2PJoinPanel.test.ts
src/app/shell/tests/RemoteConnectionsTabs.test.ts
src/app/shell/tests/remote-visual-hierarchy.test.ts`
(58 tests passed).
