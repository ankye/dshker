# Network/account information hierarchy

User requested a direct design correction of the account/network page. Baseline
checkout: d8609c4. Scope: P2PAccountPanel and its Network & account consumer.
Concurrent runtimeBrowserState and p2pNetwork changes belong to another worker
and are not part of this edit.

## Design contract

- Task: desktop network selection and occasional administration, pointer and
  keyboard. First attention is network name/selection, second is device scope,
  third is occasional editing. Account email/name identifies the user; opaque
  user/network IDs move to labeled, explained technical disclosure.
- Recipe: compact operational list with inline detail editor; restrained
  functional language. Reject always-expanded forms, marketing cards, arbitrary
  new colours/fonts and ornamental motion. No new image/icon assets.
- Existing tokens: surface/border/text/muted/accent/danger/focus, font-sans and
  mono for technical values, body/caption/section type, space-2/3/4 and radius.
  Low composition variance, state-only motion (no added animation), compact
  scan rows. Selection has both accent and text/radio, not colour alone.
- Default: editing and technical details closed; selection never inferred.
  Create is expanded when the authoritative network list is empty. Pending and
  unconfirmed operations keep their existing write/selection guards. Expanding
  or collapsing settings is local and preserves drafts. User change clears
  expansion. Deletion still names exact identity and requires confirmation;
  nothing changes RPC, identity matching or network authorization.
- Controls remain native buttons/radios/details with visible focus, keyboard
  activation and aria-expanded/controls on the editor. Closing a disclosure
  keeps focus on its trigger. No new timers or success animations.
- Width oracle: main app minimum 760px with sidebar removed from available
  content; inspect a narrower 600px browser content area as additional stress.
  No horizontal overflow; editor spans all columns; long identifiers wrap only
  inside details. Light/dark and English/Chinese retain existing tokens.

## Evidence

- 22 account component diagnostics pass, including collapsed technical details,
  explicit editor state, authoritative selected ID and display name, existing
  rename/capacity/delete/login flows. Tests remain isolated from production.
- Browser review uses tests/visual/network-account.html with existing test
  account/network values, not the user's data and not production E2E evidence.
  Checked default/selected/expanded states. Narrow review measured 600px content,
  no document horizontal overflow, network list 534px and editor body 500px.
  Found and corrected native-details grid sizing before recording that result.
- Architecture check and Electron build passed. Initial broader checks exposed
  an unrelated changing runtimeBrowserState type-check issue and an existing
  sibling test missing bootstrap.getInfo; neither is silently waived or changed
  here. A running installed App has not been replaced or restarted.

Final recheck: type-check, service smoke, visual source smoke and OpenSpec strict
validation all passed after the concurrent runtime work progressed. The earlier
sibling-test bootstrap rejection remains outside this account-only regression
result. The browser review also covers two existing network fixtures (Office/Lab).

This is not prerelease or full P2P acceptance. New UI is recorded under Unreleased
and both READMEs. Final production-app visual/state coverage remains required
before declaring the complete interface delivery accepted.
