## 1. Main-process installer handoff

- [x] 1.1 Extend the main-process update operation to open the exact completed installer and request graceful application quit only after the OS reports a successful handoff; guard DSH, workspace, and plugin-catalog Git work; verify download-generation and open-failure unit tests.
- [x] 1.2 Ensure failed OS handoff preserves the completed installer and leaves the Launcher running with a typed error; verify destination contents, quit callback, and error mapping in focused service/IPC tests.

## 2. User-visible behavior and documentation

- [x] 2.1 Update renderer update states and Chinese/English copy to explain automatic opening and orderly Launcher exit, with a visible error if opening fails; verify component and localization tests.
- [x] 2.2 Update user guides, CHANGELOG, and an Agent Note to document interactive installer handoff, retained installer, and no silent installation; verify documentation references match implemented behavior.

## 3. Verification

- [x] 3.1 Verify macOS DMG and Windows EXE handoff ordering using platform-specific service tests; verify no handoff occurs for partial or stale downloads or active Launcher work, and graceful quit is requested once.
- [x] 3.2 Run focused update/lifecycle tests, formatting, architecture, type-check, and full unit tests; record commands and outcomes in the Agent Note.
