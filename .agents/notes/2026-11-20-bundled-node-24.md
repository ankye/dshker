# Bundled runtime Node upgraded to 24.22.3

DSH 0.2.2-rc.5 declares `engines.node >= 24.9.0`; `dsh-web.log` recorded
`[WARN] Unsupported engine ... (current: {"node":"v22.23.3"})` on every DSH Web
start. The Launcher's bundled runtime was still Node 22.23.3, and the runtime
contract refuses system Node/pnpm as substitutes, so the pin itself had to
move.

- `tools/prepare-runtime.mjs` and `electron/main/pnpm-launcher.ts` now pin
  Node 24.22.3 (v24.x current, published 2026-11-11).
- All six platform archive digests and the separate
  `node-v24.22.3-headers.tar.gz` digest were replaced with the values from
  https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt — no digest was inferred
  or reused.
- `release-smoke`, `pnpm-launcher`/`prepare-runtime`/`release-smoke` tests and
  `tools/test/node-headers-archive-check.mjs` were synced; README,
  README.zh-CN, docs/architecture.md, docs/release.md and the
  `bundle-pnpm-runtime` spec text now name 24.22.3.
- OpenSpec change `upgrade-bundled-node-runtime` records the delta, including
  a scenario that a 22.23.3 stage is refused after the pin moves.
- pnpm stays 11.7.0; descriptor schema, stage layout and IPC contracts are
  unchanged. A stale 22.23.3 stage fails resolution and requires
  `runtime:prepare`, per the no-substitution rule.

## Verification

- Targeted tests: `prepare-runtime.test.mjs`, `release-smoke.test.mjs`,
  `pnpm-launcher.test.ts` — 40/40 passed.
- `format:check`, `environment:check`, `architecture:check`, `type-check`,
  `service:smoke`, and `visual:smoke` all passed.
- Full Vitest run: 2,093 passed, 2 pre-existing failures reproduced on the
  clean tree `65d2bd3` with the working tree stashed
  (`resources/dshker-directory-roots.test.mjs` — the Windows drive-roots
  listing failure already recorded in the v0.1.101 note, and
  `tools/headless-core-smoke.test.mjs` against this machine's built core);
  both are unrelated to the runtime pin.
- `runtime:prepare` staged win32-x64 Node 24.22.3 and `runtime:verify`
  passed; the staged `nodeBinarySha256`
  (`86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6`)
  equals the official `win-x64/node.exe` digest in SHASUMS256.txt.

## Packaging and follow-up

- Two local `dist:win-x64` runs built both channels with the Node 24.22.3
  stage: `dshker-launcher-test-0.1.102-win-x64.exe` (default test channel)
  and the production-identity `dshker-launcher-0.1.102-win-x64.exe`
  (`DSHKER_DISTRIBUTION_CHANNEL=stable`). The unpacked build's
  `versions.json` records node 24.22.3 and its `bin\node.exe` reports
  `v24.22.3`; `release:verify` passed against the written checksums and
  manifest.
- Two environment facts were needed to package on this machine: GitHub
  downloads for electron-builder require the local v2rayN mixed port
  (`HTTPS_PROXY=http://127.0.0.1:10808`), and TMP/TEMP must be redirected
  away from `C:\Windows\TEMP`, whose ACL breaks NSIS `!include` resolution
  (the same root cause as the spill-store EPERM scan warning in
  `dsh-web.log`).
- Installing over the running 0.1.97 app requires quitting DSHKer Launcher
  first (the running bundled node.exe is locked); this session runs as a
  child of that launcher, so the install was left to an explicit user step.
- Publication: committed as `feat: bundle Node 24.22.3 in the staged runtime`
  plus `release: 0.1.102`, pushed to `main` with annotated tag `v0.1.102`;
  GitHub Actions builds the stable installers and publishes the Release the
  user downloads.
