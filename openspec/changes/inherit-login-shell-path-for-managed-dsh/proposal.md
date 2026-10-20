## Why

DSHKer is commonly opened from the desktop, whose environment does not include shell-profile PATH entries such as a user-installed `cocos` command. DSH then starts without commands that work in the user's interactive shell, preventing CLI-driven preview and screenshot workflows.

## What Changes

- Resolve the user's login-interactive shell PATH for DSH launches on macOS and Linux, while preserving the PATH inherited by DSHKer and the bundled runtime entry.
- On Windows, preserve the process PATH inherited by DSHKer, including user-level PATH entries.
- Fail a DSH launch with a clear typed error if a required POSIX shell PATH cannot be resolved; do not substitute a guessed or partial PATH.
- Keep the resolved environment scoped to the DSH child and its descendants; do not mutate system settings or the Launcher's own process environment.

Non-goals: changing Cocos CLI behavior, adding a manual PATH editor, modifying OS-wide PATH settings, or changing the standalone DSHKer core's environment.

## Capabilities

### New Capabilities
- `managed-dsh-command-environment`: Resolve and pass the intended command search path to DSH and its child processes across supported desktop platforms.

### Modified Capabilities

## Impact

- DSHKer Launcher main-process launch services and the headless core's DSH child environment contract.
- Cross-platform tests for inherited environment preservation and login-shell PATH resolution.
- No DeepSeek Harness source changes or server changes are required.
