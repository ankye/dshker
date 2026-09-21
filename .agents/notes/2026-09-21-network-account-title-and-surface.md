# Network & account title and surface repair

## Context

The remote Network & account tab showed a duplicate page heading and its outer
surface had been reset to a transparent, borderless container. In the running
Launcher this made the page look like ungrouped text and dividers rather than a
single workspace.

## Change

- Removed the redundant in-page `Network & account` heading and description.
- Kept the tab label as navigation and retained the inner `My network` and
  account headings that identify real work areas.
- Removed the scoped reset that erased the shared `remote-add-card` surface,
  restoring the border, background, spacing, and inset from the remote route
  design tokens.
- Added a component regression test for the card class and duplicate heading.

## Verification

- `npm test -- --run src/app/shell/tests/P2PNetworkAccountPanel.test.ts`
- `npm run format:check`
- `npm run type-check`
- Live Electron window at `localhost:5173/` inspected after HMR; the outer
  workspace surface and inner headings are visible without the duplicate title.
