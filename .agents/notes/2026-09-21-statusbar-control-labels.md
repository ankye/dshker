# Status bar control labels

## Change

The bottom-left status bar now shows short visible labels beside the menu and
command-line icons. The existing accessible next-action names, unread console
badge, open state, and sidebar cycle are unchanged. Labels use the existing
caption and surface tokens, so the bar remains within its fixed height and the
compact desktop minimum width.

## Evidence

`ShellStatusbar.test.ts` and `statusbarControlWiring.test.ts` cover the visible
labels and event wiring. Focused tests, formatting, and type-check pass after
the change.
