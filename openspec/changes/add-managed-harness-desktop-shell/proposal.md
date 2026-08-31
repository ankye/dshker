## Why

DeepSeek Harness can be developed from many Git revisions, but users need a desktop application that can clone, retain, select, and run those revisions without making each version create a new Harness identity. The launcher must keep its own managed resources separate while leaving the existing Harness home (`$DSH_HOME` or `~/.dsh`) stable across branch and commit changes.

## What Changes

- Add a desktop launcher with product defaults at `~/.dshlauncher/harness`, `~/.dshlauncher/plugins`, `~/.dshlauncher/presets`, and `~/.dshlauncher/settings`; first launch does not ask users to select storage directories.
- Add managed clone, fetch, exact-SHA worktree, retained-version, and explicit branch/tag/commit selection workflows for DeepSeek Harness repositories.
- Require explicit Git, Node.js, and pnpm executable registrations; no executable discovery or substitution is allowed.
- Keep downloaded plugin and Agent preset sources under the Launcher roots. Launcher Settings own desktop selections and source records.
- Launch only the selected worktree's already-built standard `dsh web --no-open` command through the registered Node executable, and treat the loopback URL that process announces as the sole runtime address and readiness signal.
- **BREAKING** Remove the prior launcher-managed runtime-home model. The launcher neither registers nor writes the native Harness home, and it neither sets nor clears `DSH_HOME`.
- Do not require any DeepSeek Harness source, profile, plugin, or protocol change.

## Capabilities

### New Capabilities

- `managed-harness-roots`: Create and validate Launcher defaults while protecting the external native Harness home; only Launcher Settings storage is user-relocatable.
- `managed-harness-installations`: Clone and manage exact DeepSeek Harness revisions and explicit executable identities.
- `harness-runtime-supervision`: Preflight, start, stop, and recover the exact selected standard DSH Web child process.
- `desktop-launcher-experience`: Present workspace, revision, plugin-source, preset-source, settings, and runtime states without hidden mutation.
- `desktop-launcher-release-readiness`: Verify the Launcher on supported macOS and Windows release paths.
- `desktop-renderer-authority`: Confine the renderer to a typed preload surface and declared local assets.

### Modified Capabilities

None.

## Impact

- Primary repository: `dsh-launcher`, which owns Electron UI, typed preload IPC, root registration, Git worktrees, external-tool registration, source download records, runtime supervision, and release packaging.
- DeepSeek Harness remains an unmodified externally managed application.
- The renderer never receives arbitrary filesystem, shell, process, executable, or secret authority. Main-process operations require explicit registered identities and fail closed when identity or readiness cannot be proven.
