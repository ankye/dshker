# Verification checkpoint after the core work

Date: 2026-09-14
Change: `go-owned-headless-core`

This records what has actually been run and where the evidence is, so the
open items are the only things left open.

## macOS, this machine

| gate                                               | result                                                                                                                               | evidence                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `go build` / `go vet ./...`                        | clean, host and `GOOS=windows`                                                                                                       | terminal runs during the work    |
| Go unit suite                                      | every package ok                                                                                                                     | `.run/local/go-suites-macos.txt` |
| Go integration (fixture-backed)                    | `ok` in 270s: reconnect stability, real DSH, two-peer soak and abrupt loss, remote route, root registry, failure codes, headless CLI | `.run/local/go-suites-macos.txt` |
| Shell unit suite                                   | 157 files / 1291 tests passed                                                                                                        | `.run/local/one-shot-macos.txt`  |
| `type-check`, `format:check`, `architecture:check` | all pass                                                                                                                             | `.run/local/one-shot-macos.txt`  |
| Headless entry point gate                          | four checks pass (binary and manifest, `serve`, a named command, a typed refusal)                                                    | `.run/headless-core/latest.json` |
| `build:electron` + packaged shell smoke            | `ok: true`, every renderer check true                                                                                                | `.run/local/one-shot-macos.txt`  |

`.run/` is ignored by the repository, which is why the evidence lives there
rather than in a commit.

## Windows, the verification box

The whole Go suite runs green there — build, vet, and
`go test ./internal/... ./cmd/...`, `EXIT=0`, every package ok — through a
scheduled task in the interactive session, because DPAPI refuses session-0
callers. The first run had never happened and found three POSIX assumptions in
tests (two file-mode assertions Windows has no notion of, one hard-coded POSIX
destination path); CI's Windows leg found a fourth in a test added the same day.
All four are fixed, and the modes are still pinned exactly where the platform has
them. Detail and the verbatim log: `.agents/notes/2026-09-14-windows-unit-leg.md`
and `.run/windows/go-suite-windows.txt`.

## Linux, and the first time the Go suite was gated anywhere

The `verify` job is ubuntu-latest, and it now runs `go vet ./...` and the unit
suite. That is not a formality: the first run found two tests that had only ever
run on macOS and Windows — the credential stress test, which needs a real
provider and now skips where there is none, and the concurrent-call test, which
fired sixteen workers at a channel that admits sixteen calls in flight and
refuses beyond that with `p2p.helper_busy`, so a slow runner hit the test's own
documented backpressure. Both are fixed. A second step installs
`libsecret-tools` and `gnome-keyring` and runs the Secret Service round-trip
inside a session bus, so the Linux provider's live path runs where the runner
allows it and skips visibly where it does not.

The six packaging jobs also run the headless core gate per target, which is where
the Windows and Linux packaged artifacts' evidence comes from.

## What is still open

- **4.2, the checkout layer.** `electron/main/managed/git/` still owns mirror,
  worktree, revision resolution, repository inspection and remote URL handling
  (~2,500 lines of source plus its tests, and the shell's largest remaining piece
  of owned logic). Porting it faithfully is a project of its own; the installation
  catalog half of 4.2 landed earlier.
- **7.1's tail.** The shell reduction is complete except that layer: Electron main
  still runs git for checkout management, which is what 4.2 removes.
- **6.2.** The headless host can now answer a peer's runtime request (the runtime
  binding landed in 6.1), but the acceptance run — a machine with no display
  hosting a workbench that a desktop peer opens, on macOS, Windows and Linux — has
  not been performed end to end.
- **7.5's packaged pass.** The unit legs on both platforms are green; the
  installed-application pass covering desktop hosting, desktop-to-desktop and
  headless-to-desktop is still to run.
