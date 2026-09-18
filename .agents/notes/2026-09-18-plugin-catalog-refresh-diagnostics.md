# Plugin catalog refresh diagnostics

## Scope

The curated `awesome-dsh-plugin` source refresh is a Launcher-owned Git operation. It is not the DSH Web runtime and must not be silently represented as a generic harness failure.

## Decisions

- Every Git command records its operation, shell-free argument list, completion/failure, exit code, signal, and bounded stdout/stderr tail in `<launcher-root>/logs/plugin-catalog.log`.
- High-level refresh start, completion, and failure records are sent through the existing Launcher Console activity channel. The logger is diagnostic-only: an unwritable diagnostics file never changes the authoritative Git/catalog result.
- Refresh failures use `managed.plugin_catalog_refresh_failed`; local read failures use `managed.plugin_catalog_read_failed`. The renderer keeps the last successful catalog and explains the next checks instead of showing a generic Git error.
- Raw command output is bounded to the final 4096 characters and is not returned over IPC. This keeps the existing preload boundary and avoids exposing process output to the renderer.

## Evidence

`electron/main/managed/awesome-plugin-catalog.test.ts` proves a failed clone leaves a diagnostic record with the Git failure code and emits a high-level activity message. `src/app/shell/tests/versionRefreshFeedback.test.ts` pins the dedicated IPC codes and the localized log-path hint.
