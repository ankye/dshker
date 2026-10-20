# Agent Note: DSH commands need the desktop user's PATH

## Evidence and diagnosis

When DSHKer is opened from the desktop on macOS, Electron receives a minimal
PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). The configured login-interactive zsh
adds the user's command directories, including `~/.local/bin`, where `cocos`
is installed. The core already applies the PATH passed in the DSH launch
request while retaining other inherited environment variables; the missing
piece was resolving the desktop user's shell PATH before that request.

## Repair

- Resolve PATH only when either managed DSH launch flow is explicitly started.
- On macOS/Linux, invoke the configured absolute `SHELL` directly as a bounded
  login-interactive process. Parse only one nonce-marked PATH value; ignore
  startup chatter and refuse unsupported shells, malformed output, timeout, or
  execution failure with `runtime.spawn_failed`.
- On Windows, do not start a shell. Preserve the inherited process PATH using
  case-insensitive PATH lookup and duplicate handling.
- Compose bundled runtime, inherited PATH, and login-shell PATH in that order,
  scoped to the DSH child tree. Do not mutate Launcher's `process.env` or OS
  configuration, and cache successful resolution only.
- Reuse the existing `pnpmCommandSearchPath` runtime request field; no new IPC
  capability or core protocol change is needed.

## Verification record

- Full Vitest suite: 1,881 tests across 190 files passed, including command-PATH
  resolver, both managed DSH launch paths, launch log, and Launcher console
  activity.
- `go test ./internal/harnessruntime` passed, including a child-process check
  that the PATH override retains a separate inherited marker environment value
  and a cross-platform case-insensitive PATH replacement contract.
- `npm run type-check` passed.
- On this macOS host, the real configured login-interactive zsh returned a PATH
  containing `~/.local/bin`; its startup diagnostics were kept off the captured
  stdout. The PATH resolver's synthetic Windows case is covered by unit tests;
  a native Windows run remains for CI.
- Environment, formatting, architecture, type, service-smoke, visual-smoke,
  renderer/electron builds, and desktop-app validation passed.
- Packaged app verification and native Windows execution have not yet been run
  for this source change; Windows behavior is covered by cross-platform tests.
