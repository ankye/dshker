# Managed Workspaces

This domain is the renderer projection of the restricted `window.dshLauncher.managed` preload API.

It never receives a native directory path during selection: main returns a purpose-bound, one-use capability and a display name.
The four setup roots remain independent: Harness mirrors/worktrees, plugins, desktop configuration, and Launcher settings.
The native Harness home (`$DSH_HOME` or `~/.dsh`) remains outside Launcher registration and survives revision changes; it is neither Launcher configuration nor Launcher settings.

Do not add browser storage, generated sample roots, inferred paths, or a fake ready state here.

`ManagedInstallationsPanel` is the renderer projection of the future
`window.dshLauncher.managedInstallations` API. It accepts only selected workspace IDs,
one-use executable capability IDs, explicit remote URLs, and branch/tag/commit requests.
If that preload API is absent, the panel remains in its bridge-unavailable state; it never
falls back to browser Git, process launching, inferred default branches, or locally invented
installation records. Mutation responses replace its displayed toolchain/installation state.
