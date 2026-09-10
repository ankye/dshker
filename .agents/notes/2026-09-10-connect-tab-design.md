# Connect tab alignment — 2026-09-10

## Scope and design

Align the adjacent Connect tab with the network/account compact-list redesign.
Use existing dark/light tokens, spacing, borders and focus styles; no new assets.
Saved SSH computers own the first card. Name, endpoint, test/connection status
and primary actions remain visible. Add lives inside the card; management
reveals edit/remove. An authoritative empty list opens add initially.
My network prioritizes computer identity and actual coordinator status;
technical identifier and membership controls are separate native disclosures.
Join still requests the exact network ID and explains where to obtain it.

## Invariants

No transport, authorization, IPC, persistence or fallback changes. Exact IDs,
existing pending guards, drafts and removal confirmation remain intact. Errors
and offline explanations are not hidden inside secondary settings. All added
copy is in the typed Chinese and English dictionaries.

## Verification

- Focused RemoteConnectionsPanel, RemoteConnectionsTabs and P2PJoinPanel tests:
  24 passed across 3 files, including collapsed defaults and exact-ID editing.
- Type-check, architecture check, visual static smoke and Electron build passed.
- Actual components reviewed at 1280px and 660px in tests/visual/connect.html.
  At 660px document scrollWidth equals innerWidth; all four disclosures opened
  without overflowing buttons, inputs or summaries. Actions wrap below identity.
- The visual entry uses existing component-test fixtures and is not a production
  entry. This is scoped UI evidence, not real remote-connection or packaged-app
  acceptance. No installed application was replaced and no release was issued.
