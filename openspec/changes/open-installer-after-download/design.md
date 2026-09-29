## Context

See `proposal.md` and `specs/launcher-update-install-handoff/spec.md`. The main-process update service currently writes the exact selected asset into Downloads and publishes a `downloaded` state. The OS open request and quit decision must remain within the trusted main process; the renderer must not receive a path or shell capability.

## Goals / Non-Goals

**Goals:**
- Keep download, OS handoff, and quit ordering under one main-process operation.
- Quit only after the platform handler accepts opening the completed asset.
- Reuse normal graceful app shutdown and preserve the installer file.
- Keep errors typed, localized, and visible without substitution or silent retries.

**Non-Goals:**
- Silent/unattended installation, in-process application replacement, or automatic relaunch.
- Downloading a different asset, changing installer trust policy, adding checksum verification, or expanding platform support.
- Deleting the downloaded installer or changing user data.

## Decisions

1. **The existing main-process update service owns the handoff.** It already owns the selected asset URL and destination. Add injected, testable OS-open, busy-state, and graceful-quit capabilities there rather than passing filesystem paths through the renderer or adding a general-purpose shell IPC.
2. **Use the registered OS handler for the exact destination.** A successful handler request is the only condition that permits update-triggered quit. A returned error maps to a typed handoff error; leave the downloaded file and current Launcher session intact.
3. **Protect active Launcher mutations.** Refuse before transfer when a DSH, workspace, or plugin-catalog Git operation is already active. Recheck immediately before opening; if work began during the transfer, retain the file and expose an explicit retry state that opens the same exact file without redownloading.
4. **Quit gracefully through the app lifecycle.** Invoke the existing application quit path only after successful open. Do not terminate the process directly or close just the BrowserWindow, since the ordinary shutdown path owns child-process and resource cleanup.
5. **Do not silently retry or select another path.** Preserve update-generation checks and require an explicit user click to retry an OS handoff that failed or was blocked by an operation that began during the transfer.

## Risks / Trade-offs

- [The OS may accept an open request but show a security prompt or installer window asynchronously] → Quit only after the OS API reports successful handoff; the user still controls the visible platform installation.
- [A managed update begins while the larger installer downloads] → Recheck ownership state before opening and preserve the finished asset for an explicit handoff retry rather than interrupting that operation.
- [Normal quit also stops Launcher-managed runtime children] → This is intentional for a clean update handoff and must be covered by lifecycle tests; user data and the downloaded installer remain untouched.
- [A failed open leaves a completed installer on disk] → Keep the Launcher open with an explicit localized error and the existing destination; never report the handoff as successful.

## Migration Plan

No persistent schema migration is required. Update the interface copy and usage documentation in the same change. Rollback by reverting the handoff behavior while retaining the existing download-only operation.
