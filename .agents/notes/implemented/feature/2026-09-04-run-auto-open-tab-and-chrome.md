# Run view auto-open tab and chrome polish

## Context

The Run route required a manual "+" click to open its first page, so a freshly
launched DSH Web showed the "no page is open" empty state until the user acted.
Its chrome also rendered as two flat `--color-surface` gray bands (tab strip
plus address bar) stacked above the guest.

## Decision

Tab lifecycle moved to module level in `runtimeBrowserState`: a `watch` on the
announced runtime URL opens the first tab automatically when the runtime
starts, and closes every tab when it stops. Because the tab state is
module-level, the first page survives route changes; closing every tab does not
reopen — only a genuine stop/start transition does. The panel's duplicated
stop watcher was removed.

The chrome is restyled around a framed content card: the tab strip and address
row now sit transparently on the route background (no gray bands), the active
tab takes the connected-tab shape (rounded top corners, square bottom) with an
accent dot, close controls appear on hover/focus, the "+" becomes a quiet
square control at the strip's end, and the guest page is framed in a rounded,
hairline-bordered card so its own background no longer collides with chrome.

## Consequences

The Run route is immediately useful after launch instead of empty, and the
browser chrome reads as one layer with a contained page below it. All shell
tests (94) and the full suite (381) stay green; the launcher-experience spec
records the auto-open behavior.
