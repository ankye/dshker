# Task 6.2, in-repo half — a headless host, and a peer that opens what it serves

Date: 2026-09-14
Change: `go-owned-headless-core` (P6, task 6.2)

## What was missing

The suite already proved that a headless core publishes a reverse-proxy binding
while its child runs (`TestHeadlessCLIOperatesTheCore`), and that the child is a
real supervised process with a real console feed
(`TestCoreDaemonOwnsTheHarnessRuntime`). What nothing proved was the step between
them: that the address a peer is handed is an address that **answers**, with the
token the host published, the way a desktop peer opens it.

## What landed

`TestHeadlessCLIOperatesTheCore` now stands up a workbench where the fake launcher
says it listens, and after the binding is read it opens the published URL the way a
peer does: one loopback request carrying the published token.

- The request must be answered with 200 and the workbench's own body. A stand-in
  that refused a request without a token would answer 403, so the assertion also
  proves the token travelled from the host's child through the daemon, the private
  channel and the CLI to the peer.
- The port is claimed by the test before the child starts, and a busy port skips
  rather than failing, so the test cannot pass by talking to something else.

This is the reproducible half of 6.2: it runs in the fixture that already drives
the real daemon, the real control plane and a real child, on every platform the
suite runs on.

## Evidence

- `go test ./integration/ -run TestHeadlessCLIOperatesTheCore -count=1 -v` —
  PASS (0.8s), with the new assertion.
- The whole integration suite with the real coordinator and harness root:
  `ok github.com/ankye/dshker/networking/integration 271.386s`.
- `GOOS=windows` and `GOOS=linux` `go vet` over the package.

## What 6.2 still needs

The acceptance as written in the tracker is a machine with no display hosting a
workbench that a desktop peer on another machine opens. That is now proven
in-process; the two-machine run — one coordinator reachable by both hosts, a
headless host on one and the Electron launcher on the other — is an environment
build (shared trust root, enrollment for both devices, LAN or relay path) and has
not been done. 7.5's packaged three-way pass is in the same position.
