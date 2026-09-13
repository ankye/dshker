# Task 4.1, shell side: the Launcher's own roots now come from the core

Date: 2026-09-14

## What landed

`ManagedRootRegistryStore` no longer touches the filesystem. It asks the core —
`electron/main/core/roots.ts` is the client for `core.roots_inspect` and
`core.roots_commit` — and the shell's writer is gone: no atomic replace, no
symlink check, no readback, no second implementation of the rules the core
enforces. The shell keeps `parseManagedRootRegistry` and the validation it uses
to _propose_ a registry, and it validates the core's answer with exactly those
rules, which is what makes its copy disposable rather than authoritative.

Deleting the writer exposed the bootstrapping order. The registry cannot be read
before the core exists, and the core needs the Settings root to start. The
bootstrap locator is the shell's own file and already named that root, so
`ManagedWorkspaceService.locatorSettingsRoot()` reads the locator (or, before any
setup, the default the first run would register) and `main.ts` starts the core
from it. `initializeDefaultRoots()` then moves _after_ the core, because first
run registers its roots through the core like every later write.

A shell without a core has no registry at all: the store refuses with
`managed.core_unavailable` rather than falling back to a second writer. That is
design decision D5 — one writer per phase, no runtime fallback — and it is the
point of the phase. The refusal is typed, so the workspace state surfaces as
`recovery-required` with that code instead of a crash.

## The regression CI caught, and why the reorder needed one more line

Moving `initializeDefaultRoots()` after the core removed an _implicit_ dependency:
the first-run root registration was what created the Launcher's own directory, so
the remote peer broker — which writes its descriptor there at startup — found a
missing parent. Five of six packaged smoke jobs failed with
`remote.peer_unavailable` and `ENOENT: .remote-peer.json.<uuid>.tmp`.

That is a real defect, not a test artefact: the shell's own directory should never
have been created as a side effect of registering roots. `registerLauncherServices`
now creates it explicitly before anything writes below it, and the local smoke
pass through all seven routes confirms it.

The same run also showed a second, quieter failure: the _development_ core binary
predated the roots methods, so the shell's first registry read came back
`p2p.invalid_operation` — an unknown method. Rebuilding `dshkerd` fixed it, but it
is worth recording: the shell now needs a core that is at least as new as itself,
which is guaranteed in a package (they ship together) and is a manual step in a
working copy.

## The second thing CI caught: a core that refused to boot over a keyring

With the broker fixed, five of six packaged jobs passed and Linux x64 failed
differently: `secret.Open` on a host with no DBus keyring returns
`p2p.secret_provider_unavailable`, and `dshkerd` treated that as fatal. That was
survivable while the shell owned its own configuration; now the core also owns the
managed roots, so a missing keyring took the device catalog, the registry and the
whole first run down with it — the smoke failed on `managed.core_unavailable`
after logging a DBus error.

A nil store was always a legitimate configuration here: every secret method
refuses per call with `p2p.secret_provider_unavailable`, so a shell never
mistakes "no provider" for an empty store, and nothing else the core owns needs
the provider. `secretStoreFor` now tolerates exactly that — including a wrapped
sentinel — and stays fatal for every other failure, because those mean the store
exists and is broken. Its three cases pass on any platform, which the real branch
could not.

## A verification gap this round closed

Comparing the two platforms file by file showed Windows running 154 test files
against macOS's 155: `src/shared/p2p-management.test.ts`, added in round 12, had
never reached that machine. Round 12's totals matched anyway (153 against 153)
because the macOS run of the time predated the file too, so the coincidence hid
it. Windows now runs 155 files and 1281 tests, the same as macOS. The suite is
synced by directory from here rather than by an explicit file list, because a
list is exactly what silently omits the file just added.

## Verification

- `electron/main/core/roots.test.ts`: 5 cases — the two paths and the whole
  document are what cross the channel, a malformed envelope is `p2p.invalid_payload`,
  a document that breaks the shell's rules is refused with the core's own code,
  and a core refusal crosses unchanged.
- `electron/main/managed/registry.test.ts`: 7 cases. The persistence cases now
  assert routing and ownership instead of bytes on disk: every read and write
  goes to the core with the location the store was given, a store without a port
  refuses with `managed.core_unavailable`, and a core that answers with a
  different document is `managed.persistence_failed` rather than a silent success.
  The parse and validation cases are unchanged.
- `electron/main/managed/service.test.ts`: 5 cases against a port that stands in
  for the core by writing the same file the same way, so the suite still proves
  that a first run registers four roots and that the settings root is revalidated
  on every call.
- macOS: `type-check`, `format:check`, `architecture:check` and the full unit
  suite (155 files, 1281 tests) pass.
- Windows: the same suite — 155 files, 1281 tests (1278 passed, 3 platform
  skips) — against the real `dshkerd.exe`.
- The core side is covered by `internal/rootregistry` (27 cases),
  `internal/core/server_roots_test.go` and `integration/TestCoreDaemonOwnsTheRootRegistry`,
  and the byte-for-byte golden in `TestEncodeMatchesTheShellBytes` is what pins
  "the on-disk format is unchanged".

## Outstanding over 4.1's acceptance

The task asks to verify that "both the shell and the CLI read the same roots".
The shell does, through the core. The CLI reading is `dshkerd` itself for now;
a command that prints them lands with the headless entry point in 6.1, so that
half is carried there rather than claimed here.
