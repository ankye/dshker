# Architecture

DSH Launcher is the desktop owner of DeepSeek Harness installations. Its application package contains only the launcher; managed Harness source, plugins, configuration, and Launcher settings are registered as separate roots. The existing Harness-owned `$DSH_HOME` or `~/.dsh` is not a Launcher root and remains stable across worktree revisions.

## Process split

Electron main owns application lifecycle, the `dsh-app://launcher/` protocol, BrowserWindow admission, and typed IPC handlers. The preload exposes the smallest frozen `window.dshLauncher` API. The renderer owns presentation and invokes only named preload operations.

The first foundation API returns immutable bootstrap metadata. It is deliberately insufficient for filesystem, Git, process, credentials, dialog, or root-management work. A missing preload, rejected sender, or API mismatch is a typed blocked state; the renderer must not replace it with a browser, file, loopback, SDK, or in-memory fallback.

## Renderer layout

`src/app/shell/` owns the application frame. `src/app/domains/` is reserved for feature workflows, with one public domain entry per feature. `src/app/shared/i18n/` owns typed user-facing text, and `src/shared/` contains contracts shared with Electron.

`packages/desktop-foundation/` contains reusable app-neutral helpers only. Its inherited VFS modules are intentionally absent from the package public surface and the former Node VFS service exits with `service.vfs_removed`; neither is a launcher runtime path.

## Extension rules

Add a capability by defining its shared request/result types, validating its renderer sender in main, exposing only that operation from preload, and covering failure and admission behavior. Persisted paths and executable locations must be explicit registered data, never inferred defaults.
