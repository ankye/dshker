# Task 7.1, first half — the peer helper leaves the package

Date: 2026-09-14
Change: `go-owned-headless-core` (P6, task 7.1 carry-forward)

## What changed

`dshker-peer` was still built and shipped on every platform — about 17 MB per
package — although nothing has started it since the core began answering the
whole peer table (task 3.7). It is gone from the build and from the package now:

- `tools/build-peer-helper.mjs` builds one artifact, `dshkerd`, and writes only
  `dshkerd-manifest.json`. The script keeps its name because the packaging jobs,
  the release workflow and `p2p-preflight` all call it by that name; renaming it
  would be churn without a behaviour change.
- `electron/main/p2p/supervisor.ts` verifies one executable:
  `verifyCoreExecutable(root)` reads `dshkerd` and `dshkerd-manifest.json`, with no
  name argument and no frozen peer schema to keep alive. `core/supervisor.ts` is
  the only caller and is unchanged otherwise.
- `tools/after-sign-peer-helper.mjs` keeps doing exactly what it did — resealing
  every manifest in every packaged target after signing — over the one manifest
  that now exists. Its comments were the only thing that mentioned two.
- `tools/release-smoke.mjs` reads `dshkerd-manifest.json` when it verifies the
  packaged bytes, which is the artefact the runtime actually starts.
- The resealing test now packages `dshkerd` and `dshkerd-manifest.json`. Its four
  cases are otherwise unchanged, because the bug they exist for — signing
  invalidating a manifest the runtime refuses on — is about the mechanism, not
  about which binary is behind it.

## What this closes

The task's own words: this is "what makes the 'no peer helper in the shell' claim
literal". The shell now packages and verifies exactly one Go executable, and the
only pipe name that still carries the old word is the endpoint prefix both sides
already shared (`\\.\pipe\dshker-peer-`), which is a name, not a binary.

## Evidence

- `node tools/build-peer-helper.mjs --platform darwin --arch arm64` emits one
  artifact and one manifest; the target directory holds `dshkerd` (17.6 MB) and
  `dshkerd-manifest.json` and nothing else.
- `npm run p2p:preflight` passes: "Verified the darwin-arm64 core with matching
  checksum."
- The packaged smoke passes on the core-only layout, which is what proves the
  digest verification still finds and accepts the file it is told to start.
- `npx vitest --run electron/main/p2p/` is green (24 files, 371 tests), including
  the packaging contract test that keeps every platform's filter pointing at the
  directory the build produces.

## Still to do in 7.1

The rest of 7.1 is the shell reduction itself: no subprocess, credential or
checkout logic in Electron main. The launcher and managed-installation paths
still hold the DSH Web lifecycle (the launcher path now only renders the core's
record; the managed-installation path still spawns its own child), and
`electron/main/remote` is still the shell's until P4 moves it.
