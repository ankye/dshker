# 2026-09-14 - Core supervision, dual-binary packaging, and the paused-stream bug

This round lands the shell half of P1 spawn/bootstrap/supervision work (tasks
2.3 and 2.5 of openspec/changes/go-owned-headless-core/tasks.md, re-delimited
as recorded there), the dual-binary packaging change, and the CoreSupervisor
unit suite. Everything below is verified on macOS AND Windows (Windows runs
the real dshkerd.exe).

## Dual-binary build tooling

- tools/build-peer-helper.mjs now builds BOTH dshker-peer (frozen helper
  runtime, manifest schema untouched) and dshkerd (the core) into each
  build/p2p/<target>/ directory. Each binary carries its own manifest:
  manifest.json (peer, unchanged schema) and dshkerd-manifest.json (core,
  same {version, target, file, sha256} shape).
- tools/after-sign-peer-helper.mjs reseals EVERY \*.json manifest in each
  target directory, so a signed dshkerd.exe gets its hash refreshed like the
  peer already did. helper-resealing.test.ts still passes.
- electron/main/p2p/supervisor.ts: verifyPeerResource became the exported,
  name-aware verifyHelperResource(root, name) where name is restricted to
  'dshker-peer' | 'dshkerd' (anything else -> p2p.invalid_arguments). It
  picks the right manifest and executable per name; the peer call site
  passes 'dshker-peer'. stopChild and exitedWithin are now exported.

## CoreSupervisor (electron/main/core/supervisor.ts)

Lifecycle mirror of PeerSupervisor, for the core:

1. --data root validated first (absolute path, mkdir -p, lstat is a directory,
   otherwise p2p.invalid_arguments).
2. verifyHelperResource(resourcesRoot, 'dshkerd') -> byte + manifest check.
3. createPeerChannel() -> one exclusive endpoint the helper launch owns.
4. spawn with --data <root>; one-shot stdin bootstrap record.
5. readiness line, authenticatePeer, then a PROBE: core.version must echo
   version 1 before the supervisor adopts the child, else
   p2p.protocol_mismatch and the child is stopped.
6. Inbound methods are refused with p2p.not_implemented (typed refusal;
   nothing is core-visible yet, that is the P2 boundary).
7. close() -> rpc close -> stopChild (10s natural, SIGTERM, 5s, SIGKILL, 5s)
   -> remove channel. Exposes pid for diagnostics and tests.

## The paused-stream bug (important)

readPeerLine calls stream.pause() after reading its line. In Node, a stream
that was explicitly paused (readableFlowing === false) does NOT go back to
flowing mode when a new data listener is attached; resume() must be called
explicitly. Symptom: the core.version probe hung forever (the response sat
in the socket buffer) until the budget abort fired ~30s later. The existing
PeerSupervisor already does socket.resume() right after constructing
PeerRpc; my first CoreSupervisor draft put the resumes AFTER the probe
call. Fix: resume socket AND stdout immediately after constructing PeerRpc,
before any call. The peer supervisor behaves the same way.

Root cause was found with esbuild-bundled debug drivers in /tmp: a driver
replicating the spawn handshake plus an instrumented copy of rpc.ts logging
DBG#write / DBG#receive, plus a raw-socket black-box test proving the fake
core responds correctly in isolation.

## Fake core fixture (POSIX tests)

electron/main/core/fixtures/fake-core.mjs mirrors the Go entry: reads the
bootstrap record from stdin to EOF, creates the endpoint itself, writes the
readiness line, authenticates exactly one parent, answers core.version, and
exits on SIGTERM. Writes argv.json into FAKE_CORE_ARGV_OUT for the --data
passthrough assertion. On win32 the suite instead uses the real dshkerd
built for Windows (DSHKER_CORE_BINARY); the argv assertion is POSIX-only
there - the serving proof comes from the boot test.

## Evidence (both platforms green)

- macOS vitest: core suite 7/7 (boot + version probe, --data passthrough,
  close leaves no process, SIGTERM leaves no process, SIGKILL crash ->
  unavailable, tampered manifest -> helper_integrity_failed, missing
  resource -> helper_resource_unavailable, non-directory data root ->
  invalid_arguments tested on win32). Full repo: 147 files / 1222 tests.
- Windows vitest (real dshkerd.exe): core suite 7/7, identical assertions.
- Windows go: localrpc 2.471s ok, secret 1.207s ok, integration
  (TestCoreDaemon\*) 3.903s ok.
- Gates: type-check clean, prettier clean, architecture:check ok, p2p
  suites (340) and helper-resealing regression unaffected and passing.

## Notes / deferred

- validate-desktop-app flags many pre-existing machine-path hits (notes,
  test fixtures, and REQUIRED production code: the Windows named-pipe
  strings in wire.ts and private-channel.ts, and docs). Those were red
  before this round; fixing them would mean changing required production
  code or deleting evidence notes, so they are recorded here as known noise.
  Nothing in this round new files is flagged.
- The SIGTERM/quit production hooks (app lifecycle calling CoreSupervisor
  close) land with the P2 shell wiring (the 2.3 renderer half); the
  termination mechanism and its no-survivor proof are complete here.
- Packaging runs (dist/P4+) will exercise the dual manifests end to end
  through electron-builder and the after-sign reseal on both platforms.
