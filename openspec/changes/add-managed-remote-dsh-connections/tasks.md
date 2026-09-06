## 1. Contracts and persistence

- [x] 1.1 Add exact remote catalog, connection-state, request, peer descriptor, IPC channel, and typed error contracts; verify shared-contract and IPC parser tests reject unknown or authority-bearing fields.
- [x] 1.2 Implement the strictly versioned remote computer catalog with atomic writes and transient disconnected restoration; verify absent, valid, malformed, unsupported, duplicate, and round-trip records in focused unit tests on POSIX and Windows path styles.

## 2. Peer and SSH runtime

- [x] 2.1 Implement the loopback-only authenticated peer descriptor and runtime-connect endpoint around the existing Launcher Harness service; verify address binding, secret rotation/schema, authorization, exact announced URL, start-on-request, and shutdown cleanup in focused tests.
- [x] 2.2 Implement explicit OpenSSH/SCP command construction, temporary descriptor retrieval, strict validation, loopback port reservation, two supervised forwards, URL authority mapping, generation fencing, and cleanup; verify command arguments, malformed peer data, unsafe URLs, process exits, disconnect, and missing-tool failures in focused tests for macOS and Windows command contracts.
- [x] 2.3 Compose the peer broker and remote connection service in Electron main, register named sender-validated IPC and preload methods, broadcast state changes, and stop all remote processes on quit; verify IPC admission and shutdown tests.

## 3. Remote Connections experience

- [x] 3.1 Add the fixed Remote Connections sidebar route, typed locale copy, add form, multi-computer list, explicit state labels, and create/connect/disconnect/retry/remove behavior; verify default, validation, connecting, ready, failed, and pending-action component tests.
- [x] 3.2 Replace disposable Run tabs with stable `local` and `remote:<id>` projections, remove close/new controls, preserve selection, and render non-ready local/remote recovery states; verify local stop/start, remote catalog changes, ready/failure transitions, removal focus, and route remount tests.
- [x] 3.3 Update shell route, layout, responsive styling, icons, and smoke route inventory; verify keyboard-visible controls, narrow-window overflow behavior, and route reachability tests.
- [x] 3.4 Add a one-shot full-path connection test, process-local test result, strict operation exclusion, and textual red/green connection indicators; verify service, IPC, preload, and component behavior.

## 4. Integration and delivery evidence

- [x] 4.1 Add an Agent Note covering ownership, threat model, credential lifetime, process topology, and rejected LAN/private-key alternatives; verify the note and OpenSpec strict validation pass.
- [x] 4.2 Run focused tests plus `npm run environment:check`, `npm run format:check`, `npm run architecture:check`, `npm run type-check`, `npm test -- --run`, `npm run service:smoke`, `npm run visual:smoke`, `npm run build`, and `npm run build:electron`; record any platform-only package/runtime evidence that remains required rather than claiming it passed.
- [x] 4.3 From the desktop workspace root run `node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json` and verify production output contains no mock/fixture service or credential artifacts.
- [x] 4.4 Re-run focused and full validation after connection-test integration, including OpenSpec strict validation, format, type, architecture, unit/component tests, visual smoke, Web build, Electron build, service smoke, and workspace app validation.
