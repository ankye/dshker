# Reveal hidden window on app activation — 2026-09-21

## Symptom

With the default minimize-to-tray close behavior, clicking the window close
button hid the BrowserWindow but kept it alive. Clicking the Dock/desktop app
icon fired Electron's `activate` event; the old handler only called
`createWindow` when there were zero windows, so the hidden window remained
invisible. The tray icon could still reveal it, which made the app look stuck.

## Fix

`revealWindow` now restores, shows and focuses a non-destroyed window. Both
`second-instance` and `activate` use it; `activate` creates a new window only
when no usable window exists.

## Validation

- Window regression test covers a minimised/hidden existing window receiving
  restore, show and focus.
- Focused window/tray tests: 2 files, 16 tests passed.
- Full test suite after the change: 164 files, 1,465 tests passed.
