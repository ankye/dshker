## Why

The update flow currently downloads an installer but leaves users to find and launch it manually. After an explicit Download action completes, opening the visible OS installer UI and then closing the Launcher makes the handoff clear while allowing the platform installer to replace the running application.

## What Changes

- After a user explicitly starts a macOS or Windows installer download, open that exact selected release asset with its registered OS handler only after the complete file has been saved.
- Quit the Launcher gracefully only after the OS accepts the open request; allow its normal shutdown path to clean up Launcher-owned runtime processes and resources.
- If opening fails, keep the Launcher running, preserve the completed installer, and report a typed, localized error. Do not substitute another installer or silently retry.
- Keep installation interactive: no unattended install, in-app replacement, automatic relaunch, or deletion of the downloaded installer.
- Update update-flow copy, documentation, and focused lifecycle tests to describe the visible installer handoff and Launcher exit.

## Capabilities

### New Capabilities

- `launcher-update-install-handoff`: Open the exact, fully downloaded platform installer after the user's explicit download action, gracefully exit after successful OS handoff, and preserve an actionable error state if the handoff fails.

### Modified Capabilities

None.

## Impact

- Primary repository: `dsh-launcher` Electron main-process update service and application lifecycle, Launcher-operation tracking for plugin-catalog Git refresh, renderer update states and localized copy, update tests, both READMEs, user/release guides, changelog, and Agent Note.
- No DeepSeek Harness, `dshkerd`, coordinator, or other repository changes.
- No renderer shell/process capability or new IPC operation is required; installer opening remains inside the existing main-process download operation.
