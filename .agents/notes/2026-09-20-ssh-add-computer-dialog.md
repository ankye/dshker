# SSH add-computer dialog boundary — 2026-09-20

## User-visible issue

The SSH connection page left the add-computer form embedded in the list. The
network-related entry was also easy to confuse with SSH actions, and the modal
had no clear title-level close affordance.

## Repair

- Keep the SSH tab focused on managed SSH computers; network creation and network
  membership stay in Network & account.
- Open add-computer from one explicit button into a modal with a backdrop,
  labelled heading, security hint, close button, Cancel action and responsive
  layout.
- Move focus into the first field on open and restore it to the trigger after
  Escape, backdrop, header-close or Cancel. A successful create closes and
  clears the draft; a failed create keeps the entered values.
- Add title-bar close controls to the create/manage network dialogs so the
  primary exit action is visible without scrolling to the footer.

## Validation

`npm test -- --run src/app/shell/tests/RemoteConnectionsPanel.test.ts
src/app/shell/tests/RemoteConnectionsTabs.test.ts
src/app/shell/tests/P2PAccountPanel.test.ts src/app/shared/i18n`
(53 tests passed).
