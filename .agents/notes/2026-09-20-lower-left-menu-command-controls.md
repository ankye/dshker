# Lower-left menu and command-line controls

## Request

Replace the lower-left shell controls with a clear menu button and a command-line button, and use a small red dot to indicate unread command-line output.

## Implementation

- Kept the status bar as the single home for both controls so they do not overlay the Run guest.
- Replaced the sidebar presentation glyph with a hamburger/menu icon while preserving its expanded/collapsed/hidden cycle and accessible next-action labels.
- Marked the console control as a command-line icon and changed the unread badge from accent blue to the theme danger red with a one-pixel contrast ring.
- Updated the active OpenSpec, changelog, and focused component coverage.

## Validation

- Focused shell tests: 3 files, 17 tests passed.
- Full test suite: 164 files, 1,434 tests passed.
- Changed-file Prettier check, type-check, architecture check, production build, Electron build, visual smoke, and desktop workspace validation passed.
- Repository-wide `format:check` remains blocked by 12 pre-existing formatting warnings in unrelated files, including the existing untracked pnpm lock/workspace files; none are part of this change.
