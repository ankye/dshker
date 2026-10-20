## 1. Resolve the DSH command PATH

- [x] 1.1 Add a lazy, bounded login-shell PATH resolver for macOS/Linux and verify shell output parsing, supported-shell handling, timeout, malformed output, and failure behavior with unit tests.
- [x] 1.2 Compose bundled, inherited, and login-shell PATH entries without mutating the Launcher's environment; verify ordering, deduplication, spaces, and Windows inherited PATH behavior.

## 2. Pass the environment to DSH

- [x] 2.1 Wire the shared resolver into both managed DSH launch flows and verify the resolved value reaches the existing runtime request; verify resolver failure refuses launch with a typed error.
- [x] 2.2 Verify the core supervisor applies the PATH override while preserving every other inherited environment entry on Unix and Windows-compatible contracts.

## 3. Record and validate the change

- [x] 3.1 Add an Agent Note and CHANGELOG entry, inspect both READMEs for stale PATH launch guidance, and run strict OpenSpec validation plus focused app/core tests.
- [x] 3.2 Run required formatting, architecture, type, unit, build and desktop-app validation.
- [ ] 3.3 Run exact-SHA macOS and Windows CI/package checks and retain their results before release.
