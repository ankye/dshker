# Windows pnpm startup repair

The resolver assumed ../node_modules but the installed Scoop/npm shim declared its own node_modules directory, causing spawn pnpm ENOENT. It now reads the actual target, follows symlinks, supports Corepack and native pnpm, and resolves an absolute Node path. Named package-manager paths supplement GUI PATH. Missing tools fail before spawn; macOS is unchanged.

Validation: six focused cases; 91 suites, 497 passing tests, two pre-existing skips; type, architecture, environment, service and visual checks; Electron build. Installed pnpm probe succeeded. The repaired installed Launcher started its selected Harness; authenticated HTTP returned 200 with 24,168 HTML bytes. Evidence and original app.asar backup: .run/pnpm-startup-repair/. No public release or Git submission.

The earlier Mac 401 diagnosis was a probe error: redirect authentication requires a cookie jar; cookie-aware access returned 200. The Windows remote port was independently corrected from 21 to 22.
