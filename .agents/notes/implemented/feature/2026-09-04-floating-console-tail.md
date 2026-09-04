# Floating console tail drawer

## Context

Operations and launches start on every route, but live output only rendered on
the Console route; watching a switch meant navigating away from the button that
started it. The user proposed a floating console visible from every tab, with
its toggle beside the sidebar's expand/collapse control.

## Decision

A bottom-docked overlay drawer (`ConsoleDrawer`), not a draggable floating
window: logs are wide monospace lines, and a docked tail keeps containment,
z-order, and responsive behavior predictable. It renders the newest 200 entries
of the pushed feed (`harnessConsole`, now exported from the domain index),
reuses the Console route's stream labels and dark log vocabulary, and stays
read-only — "Open console" hands off to the full route instead of duplicating
copy/export/reveal controls.

Entry points: a control on the sidebar's floating rail directly above the
sidebar state control (present in expanded, collapsed, and hidden states, with
`aria-expanded` and an unread badge), and the statusbar's busy strip (now a
real button with an inner live region). The drawer never opens by itself: the
badge (`consoleDrawerState`, session-only, baseline marked at mount so startup
history is not "unread") advertises new output while closed, and opening marks
the feed seen. Escape collapses; the toast keeps `position: relative` with a
higher z-index so failures are never covered by the tail they explain.

## Consequences

Every route can watch operation and launch output without navigation, while the
Console route remains the single full-fidelity surface — the layered
route-plus-tail relationship is recorded in the launcher-experience spec. The
statusbar progress strip doubles as the natural second entry point because it
already narrates the running operation. Tests pin the unread baseline/sync
lifecycle, the bounded tail slice, Escape and hand-off behavior, the sidebar
control's expanded/unread states, and the statusbar toggle emission.
