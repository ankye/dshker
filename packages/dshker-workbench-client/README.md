# DSHKer workbench client extension

Launcher-owned, client-only DSH plugin. Uses the public `ISessions` and `IWorkspaces` services, without changing Harness source, private stores, the agent loop or coordinator.

The host entry only participates in the normal DSH plugin loader. The browser entry requires the frozen, versioned `window.dshkerWorkbench` capability provided by a Launcher-owned isolated guest preload. Ordinary browsers without this capability report `workbench.unavailable`; they never acquire IPC, filesystem, process or credential access through this package.

Operations are `navigate`, `selection` and cancellation of the named active request. Requests carry an explicit request id, monotonic sequence, workspace id, session id and canonical remote path. Navigation refreshes the public session list, waits for the workspace feed, validates membership and path equality, calls `sessions.open`, and reads the selected session back. It does not create a project, execute tasks or replay prior commands. Missing/stale/mismatched state fails explicitly. Reload/unload cancels pending work; acknowledgements cannot cross documents. Cancellation does not undo an already selected session or stop a running task; callers read back uncertain results.

Compatibility is checked against an explicitly supplied managed Harness checkout during build/type checking. No checkout, installed version or runtime endpoint is inferred. Baseline `a66e4702047846cdaa10c66c9d3df3951f5ea70d` passed isolated real DSH/Electron plugin-load, navigation readback, live session switch, reload/re-registration and wrong-path rejection diagnostics. This does not certify other Harness versions or production remote composition.

The host entry is ESM; the client entry uses DSH's classic-script module factory registration, not native ESM. A standard `dsh.bundle` patch enables the plugin through normal profile installation. The build checks the emitted registration, exports and dependency closure.

Current status: standalone extension implemented, with focused tests and isolated real-client diagnostics. Production packaging, managed-plugin installation, guest/main registration wiring and actual two-peer DSH UI validation remain prerequisites for release. Tests and build tools must not be included in plugin payloads.
