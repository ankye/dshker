# Open the update installer and exit cleanly

## Decision

After an explicit update download, the main process opens the exact completed
macOS DMG or Windows EXE with the OS handler. Only an accepted open request
requests `app.quit()`, which enters the existing normal shutdown sequence and
cleans Launcher-owned runtime state. The downloaded installer remains in
Downloads; the user still confirms installation. This is not silent
installation, in-process replacement, or relaunch.

If the OS refuses the open request, Launcher stays open, keeps the completed
file, shows a typed/localized error, and lets the user explicitly retry opening
that same file without downloading it again. An active DSH, workspace, or
plugin-catalog Git operation prevents the handoff. If one starts during
download, the completed file is kept for an explicit retry. Plugin-catalog Git
refresh now exposes its active state to both update handoff and window-close
protection.

## Validation

- `npm run environment:check` — passed.
- `npm run format:check` — passed.
- `npm run architecture:check` — passed.
- `npm run type-check` — passed.
- Focused update/IPC/shutdown/catalog/UI tests — 5 files, 76 passed.
- `npm test -- --run` — 164 files passed, 2 skipped; 1,490 tests passed, 4 skipped.
- `npm run service:smoke` and `npm run visual:smoke` — passed.
- `npm run build` and `npm run build:electron` — passed.
- `node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json` from
  `desktop_workspace` — passed with no issues.

The macOS DMG and Windows EXE handoff paths and OS rejection paths are
service-tested with injected OS-handler results; this run did not open a real
native installer UI on either OS or perform a separate native Windows GUI
acceptance test.
