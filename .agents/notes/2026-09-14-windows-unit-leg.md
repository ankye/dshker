# The Windows unit leg, run for the first time on the new core

Date: 2026-09-14
Change: `go-owned-headless-core` (quality evidence for P2 to P6)

## What ran

The whole Go suite on the Windows box, against a tree synced from the working
copy: `go build ./...`, `go vet ./...`, and
`go test ./internal/... ./cmd/... -count=1`. The suite is started through a
scheduled task in the interactive console session, because the Windows credential
provider (DPAPI) refuses to unprotect data from a session-0 service context — the
same reason the credential and stress tests have always been run that way.

The macOS runs had been green throughout, so this was the first time the Go code
written for this change executed on Windows at all.

## What the first run found

Three failures, all of them POSIX assumptions in tests rather than defects in the
shipped behaviour:

1. `internal/peerbroker`: the published descriptor was asserted to be mode
   `0600`. Windows has no POSIX permission bits, so it reported `0666`.
2. `internal/remoteroute`: the descriptor intake directory was asserted to be
   `0700`, and Windows reported `0777`.
3. `internal/remoteroute`: the scp argument test hard-coded a POSIX destination
   path, so the built argument (`\tmp\route\remote-peer.json`) could never equal
   the expected one.

The fixes keep the intent instead of weakening the assertion: on the POSIX
platforms the modes are still pinned exactly, using the rule the private endpoint
record's own test already uses (`runtime.GOOS != "windows"`), and the scp
destination is built with `filepath.Join` so the comparison is against the
spelling the platform actually produces. On Windows both files live under the
user's own profile and inherit its ACLs, which is that platform's protection.

A fourth instance of the same mistake was caught by CI rather than by the box: the
Vitest Windows leg failed on the test added with the managed installation runtime
test, which used POSIX worktree paths, and a Windows path is only absolute with a
drive letter on it. It now builds its path with `nodePath.resolve`.

## The second run

`BUILD=0`, `VET=0`, and every package ok, in order: catalog 3.8s, controlplane
1.6s, core 3.1s, harnessruntime 3.0s, helper 1.7s, installcatalog 2.7s, localrpc
4.0s, peer 8.8s, peerbroker 1.6s, peersession 0.8s, protocol 1.7s,
remoteconnections 2.7s, remoteroute 1.0s, rootregistry 1.0s, runtimebridge 4.6s,
secret 2.4s, cmd/dshkerd 0.9s, `TEST=0`.

That run covers everything this change added on the core side: the runtime
profiles, the port rules, the remote route and its broker, the connection and
installation catalogs, the root registry, the SSH route, the runtime binding, the
Linux provider's platform-neutral logic, and the headless commands.

## Evidence kept

- `.run/windows/go-suite-windows.txt` — the verbatim terminal output of the
  passing run, kept locally because `.run/` is ignored by the repository, as the
  release evidence rules require.
- CI: the Windows Vitest leg and the six packaging jobs (which now also run the
  headless core gate per target).

## What this does not cover

The packaged end-to-end pass on Windows is still 7.5: this run proves the unit
suites, not an installed application. The stress tests that need a live
coordination server remain the explicit fixture-backed run.
