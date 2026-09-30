# Agent Note: DSH Web startup needs standalone Node

## Evidence and diagnosis

The Launcher log at `~/.dshlauncher/logs/dsh-web.log` showed the DSH Web child
exiting during native host preparation:

```text
node-addon-require-builtin unsupported: Unsupported/no-context
Node 24.21.0, V8 ...-electron.0
has_v8_context: false
```

The failing process had been started by reusing Electron as Node. Updating
Electron from 42 to 43 did not fix the missing V8 context. A standalone Node
22.23.3 process loaded the same installed DSH `node-addon-require-builtin`
package and `internal/modules/esm/loader` successfully.

## Repair

- Stage the official Node 22.23.3 binary and license for the exact target, with
  pinned official archive SHA-256 values and a schema-2 runtime descriptor.
- Run bundled pnpm and DSH Web on that executable; fail launch when the required
  stage is absent or invalid. Never substitute system Node/pnpm or Electron.
- Disable Electron's `runAsNode` fuse and strip inherited
  `ELECTRON_RUN_AS_NODE` from the core, pnpm, and supervised DSH child.
- Keep the shell/core method table at version 1 because no IPC payload changed.
- Use native platform/architecture packaging runners, including Linux arm64,
  because each downloaded runtime must be executed during smoke preparation.

## Verification record

- `npm run runtime:prepare` and `npm run runtime:verify` passed on darwin-arm64;
  the stage reported standalone Node 22.23.3 and pnpm 11.7.0.
- The staged Node had no `process.versions.electron`, loaded
  `internal/modules/esm/loader`, and successfully loaded the real DSH native
  addon from the active DSH installation.
- Focused regression passed: 56 Vitest tests and the Go core/harnessruntime/daemon
  packages passed; format, architecture, and type checks passed.
- Quality Engineering static gates passed: the test-integrity manifest binds
  every changed production file to evidence, and all changed human code files
  remain below the 1,000-line limit.
- A local source build of DSHKer Launcher ran the active installed DSH checkout
  using `resources/runtime/bin/node --expose-internals` and announced its
  loopback URL. The embedded Browser tab rendered the existing DSH workbench
  session. A direct Node fetch followed the expected one-time-token 303 without
  retaining its cookie and consequently ended at 401; the UI navigation itself
  completed and rendered correctly.
- The first dev attempt reported `p2p.missing_field` while using the existing
  generated `build/p2p/darwin-arm64/dshkerd`. Rebuilding that helper from the
  current source and restarting the app removed the error; the package workflow
  also rebuilds this helper from the current source before creating artifacts.
- All non-package `release:readiness` stages passed, including 1,513 unit tests,
  E2E, service/visual smoke, and performance gates. Local packaging successfully
  built the app but stopped at macOS code signing because this host's Apple
  timestamp service was unavailable. Native package verification and smoke are
  delegated to the release's GitHub Actions matrix.
- The first GitHub tag run (`v0.1.84`) passed release-input checks but exposed a
  race in the Unix inherited-environment test: it read the child log after the
  process state changed but before the stdout pipe had drained. The test now has
  the child synchronously write its observed environment to a dedicated file;
  25 focused repetitions pass. Since release tags are immutable, the corrected
  source was published as `v0.1.85`; the failed `v0.1.84` tag is retained without
  a GitHub Release.
- GitHub Actions run
  [36757598697](https://github.com/ankye/dshker/actions/runs/36757598697)
  passed source verification, all six native desktop package jobs, all six
  standalone CLI target jobs, and publication. Stable `v0.1.85` is not a
  prerelease and has 25 uploaded assets, including installers, checksums,
  manifests, CLI archives, and install scripts.
