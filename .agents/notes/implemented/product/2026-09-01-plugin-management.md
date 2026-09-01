# Plugin management through the DSH CLI forwarder

Date: 2026-09-01

## Context

The Extensions tab read only `dependencies` from
`$DSH_HOME/profiles/web/package.json`, which is empty on a fresh profile, so
the plugin list rendered nothing even though DSH ships in-box template bundles.
DSH's real plugin model (see `apps/cli/src/plugin.ts` in the Harness checkout)
is: `dsh.profile.bundles` names every active layer, template bundles are not
dependencies and can never be removed, and every dependency is a
user-installed plugin. `dsh plugin --profile web <pnpm args>` is the standard
forwarder that installs/removes and reconciles the bundles list.

## Change

- `parseProfilePluginRecords` (in `launcher-harness-service.ts`) derives the
  plugin view from the manifest: bundles that are not dependencies become
  `origin: 'default'`; dependencies become `origin: 'user'`. Covered by unit
  tests in `launcher-harness-service.test.ts`.
- Two named typed IPC operations were added —
  `launcherHarness:install-plugin` and `launcherHarness:uninstall-plugin` —
  validated in `electron/main/ipc.ts` (GitHub HTTPS source / package-name
  admission) and exposed from the preload. Both run
  `pnpm dsh -- plugin --profile web add/remove …` in the Launcher-owned
  Harness checkout through the direct node/pnpm launch path; the Launcher never
  writes the profile manifest or node_modules itself. Both are blocked while a
  Launcher-started DSH Web process is running.
- Extensions view shows an origin badge (默认 / 用户安装) and an uninstall
  action only for user-installed plugins. The Install-extension view gained
  multi-select checkboxes, per-row and batch install actions, and a denser
  layout (12px font, clamped description cells) so rows stay readable.
- OpenSpec `desktop-launcher-experience` was updated: the Install-extension
  view now allows explicit user-triggered install/uninstall through the DSH
  CLI forwarder instead of forbidding installs outright.

## Verification

`npm run type-check`, `npm run format:check`, and the focused vitest suites
(`launcher-harness-service.test.ts`, shell, i18n) pass.
