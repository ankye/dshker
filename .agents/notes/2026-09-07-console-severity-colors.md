# Console severity colors

Date: 2026-09-07
Track: desktop
Change: `add-managed-harness-desktop-shell`, tasks 8.1–8.3

## Request and cause

Normal console output was red because the legacy route stylesheet colors every stderr row red. DSH and command-line tools also emit ordinary information and progress on stderr. Stream identity does not establish severity.

## Implementation

- `src/app/shell/consoleOutput.ts` derives presentation only from explicit logger levels, recognized CLI/exception/compiler diagnostics, and Launcher failure/exit messages. Normal, info, command, and warning-level text use green; explicit errors use red. Logger levels take precedence over words in the message. A following stack frame in the same fragment keeps the error color.
- `ConsoleOutputText.vue` owns both text colors independently from the legacy stream-colored row. Controller and drawer share this component. The legacy stylesheet is unchanged; source labels remain muted and distinguish stderr from stdout.
- Raw text, newline bytes, sequence, timestamps, stream identity, copy, export, feed retention, runtime state, IPC, and native persistence remain unchanged. Empty text produces no invented line. This is not a structured log protocol: split/incomplete or unrecognized diagnostic headers do not get an invented error level.
- Existing remote/P2P edits are preserved and are not included in this console fix.

## Validation

- `TMPDIR=/private/var/folders/8l/k98lf_j109g_07p3px4r09nc0000gn/T npm test -- --run`: **95 files, 558 tests passed**. The canonical temporary directory avoids the known macOS `/var` versus `/private/var` test-fixture mismatch; no unrelated test or timeout was changed.
- Five focused suites cover classification, render replacement/reset, HTML escaping, copy fidelity, per-line presentation in both consoles, and green/red computed styles with the real authored route stylesheet. Vitest skips CSS imports, so the cascade test reads that stylesheet from disk rather than testing an empty import.
- `npm run type-check`, `architecture:check`, `environment:check`, `service:smoke`, `visual:smoke`, `build`, and `build:electron`: passed. `visual:smoke` is a static check, not screenshot acceptance.
- `openspec validate add-managed-harness-desktop-shell --strict`: passed.
- `node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json`, from desktop_workspace: passed.
- Quality source-size check over all nine changed source/test files: measured 9, failures 0, limit 1000.
- `git diff --check`: passed. No new production test/fixture imports; only existing console contracts and the shared presentation component are used.

## Acceptance limits

- `npm run electron:renderer-smoke` reported `ok: true` and exited 0 after its orphaned diagnostic Electron process was terminated. That exact process was identified by its test-only port 9909 and repository Electron executable; the installed app was not stopped. Inspection of `.run/electron-smoke/renderer.png` showed only the initial dark background. The smoke's body-presence check is not adequate proof of a mounted console or real color behavior. Do not count this image as native visual acceptance.
- `test-gates/console-severity.json` and its diagnostic interaction contract record the intended public-UI checks. Scoped static manifest validation passes. Default `check_test_integrity.py --repo . --manifest test-gates/console-severity.json` fails closed because the working tree also contains unrelated remote/P2P production changes outside this manifest. A real public-UI color ledger for both platforms is still absent. No full acceptance, release, or packaged production-isolation pass is claimed.
- No installed app replacement, new installer, version bump, commit, push, or release was performed.
