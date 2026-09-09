# Simplified P2P remote-connections UI (My Network)

## Ownership

- The Connect tab now contains only SSH management plus the「我的网络」card
  (`src/app/shell/components/P2PJoinPanel.vue`). The service-management UI
  (`P2PManagementPanel.vue`) is no longer mounted in any tab, but the file
  stays in the repo with its tests.
- The coordinator is always the built-in official server. The renderer only
  stores its identity and the four endpoint fields stay in
  `src/shared/p2p-management.ts` as a compile-time preset; they are never
  shown or edited by the user.
- `p2pManagement.ensureBuiltinService()` (src/app/domains/remote-connections/p2pManagement.ts)
  provisions the built-in service automatically: enables P2P when the catalog
  says disabled, adds `P2P_BUILTIN_SERVICE` when the catalog has none, and
  selects it. It is idempotent (at most one add per document, guarded by
  `builtinProvisioned`/`#ensuringBuiltin`) and records a terminal
  `builtinRemoved` state only when the server refuses re-adding with
  `p2p.trust_restore_rejected`; every other failure stays retryable.

## Card states

1. Not joined: device name (local draft, seeded once with a localized default)
   - device identifier (placeholder until a server confirms one) + a single
     network-ID input +「加入网络」.
2. Pending: input greyed out, button becomes「取消申请」, status「等待审批」.
   Cancel is readback-based (`p2pEnrollment.cancelJoin`): it re-reads the
   registration and clears the pending draft only when the readback proves no
   registration exists (`p2p.credential_unavailable` or
   `p2p.enrollment_not_found`); a still-pending readback stays pending, a
   revealed registration is adopted. No cancellation is ever faked.
3. Registered: no input; shows device name/identifier, network status
   online/offline/banned, and「离开网络」. Online is shown only when a live
   connection stage in `p2pConnections` is `ready` for the service,
   otherwise offline; banned maps from `p2p.network_revoked`/`p2p.pair_revoked`
   leave errors. No online state is ever assumed.

## Wired vs stubbed

- Wired: built-in auto-provision + selection; join form; pending readback
  cancel; error surfacing (network_full, invalid, unknown network,
  unconfirmed).
- Stubbed (refuses cleanly, never fakes success):
  - `joinNetwork` — existing typed stub in
    electron/main/p2p/management-ipc.ts (throws `p2p.invalid_operation`).
  - `leaveNetwork` — new typed channel/admission/preload + stub in
    electron/main/p2p/management-ipc.ts (throws `p2p.invalid_operation`);
    the local Go helper does not expose device removal yet. The UI keeps the
    registration and shows「离开网络暂不可用」with the code.
- i18n: added `p2p.myNetwork.*` to both catalogs; removed now-unused
  `p2p.join.*` keys and the unreferenced `p2p.accountTab.leaveNetwork`;
  kept the `p2p.join.error.*` keys used by the card.

## Evidence

- `npm run type-check`, `npm run architecture:check` green.
- Focused Vitest: src/app/shell, src/app/domains/remote-connections,
  electron/main/p2p, electron/p2p-management-preload.test.ts — 61 files,
  640 tests passed; i18n parity (6) and ManagedWorkspacesPanel (5) also pass.
- `npx prettier --check` on every touched file passes.
- OpenSpec untouched per task constraints; not committed.
