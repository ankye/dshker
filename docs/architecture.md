# Architecture

DSHKer Launcher is the desktop owner of DeepSeek Harness installations. Its application package contains only the launcher; managed Harness source, plugins, configuration, and Launcher settings are registered as separate roots. The existing Harness-owned `$DSH_HOME` or `~/.dsh` is not a Launcher root and remains stable across worktree revisions.

## Process split

Electron main owns application lifecycle, the `dsh-app://launcher/` protocol, BrowserWindow admission, and typed IPC handlers. The preload exposes the smallest frozen `window.dshLauncher` API. The renderer owns presentation and invokes only named preload operations.

The first foundation API returns immutable bootstrap metadata. It is deliberately insufficient for filesystem, Git, process, credentials, dialog, or root-management work. A missing preload, rejected sender, or API mismatch is a typed blocked state; the renderer must not replace it with a browser, file, loopback, SDK, or in-memory fallback.

## Renderer layout

`src/app/shell/` owns the application frame. `src/app/domains/` is reserved for feature workflows, with one public domain entry per feature. `src/app/shared/i18n/` owns typed user-facing text, and `src/shared/` contains contracts shared with Electron.

`packages/desktop-foundation/` contains reusable app-neutral helpers only. Its inherited VFS modules are intentionally absent from the package public surface and the former Node VFS service exits with `service.vfs_removed`; neither is a launcher runtime path.

## Connection state layering

Remote connections have two independent layers, and a surface must not answer one with data from the other. The **network session** (`p2pNetwork`) is this computer's session with a coordinator: it decides presence, discoverability and whether pairing is possible. A **pair connection** (`p2pConnections`) decides whether one specific remote workbench is reachable. Deriving network status from pair stages made a single enrolled computer report itself offline for a stage it could never reach.

Both layers distinguish "not read yet" from a confirmed negative state, and neither is derived per surface: the shell seeds both at start and main pushes session changes. A peer tab's status is projected without an address, because the DSH entry point stays in main. See [P2P connection state](handover-p2p-connection-state.md).

## Extension rules

Add a capability by defining its shared request/result types, validating its renderer sender in main, exposing only that operation from preload, and covering failure and admission behavior. Persisted paths and executable locations must be explicit registered data, never inferred defaults.
