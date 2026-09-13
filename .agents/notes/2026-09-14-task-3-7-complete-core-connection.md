# Task 3.7 complete: a pair connection with the core as the only local process

Date: 2026-09-14

## What landed

`dshkerd --roots <absolute PEM file>` adds CA certificates for the coordinator
HTTPS connection on top of the system store. `helper.Host` gained `SetRoots`, and
`configure` passes the pool to `controlplane.New`. An unreadable or certificate-less
bundle is refused at boot rather than silently falling back to system roots,
because the caller asked for those anchors specifically.

That closed the last gap in 3.7: `integration/TestCoreDaemonCompletesAPeerConnection`
runs the real `dshkerd` against the integration fixture's production coordinator
with **no Electron, no `dsh web` and no `dshker-peer`** — the second device runs
in-process so the workbench it hosts can be a stub. The daemon configures the
service, restores the device identity and pair pin, initiates `peer.connect`,
selects a direct UDP path, and reports `ready`; the address it returns survives
`runtimebridge.Probe`, which is authenticated HTTP against the stub plus a frame
echoed over the DSH websocket mux, all through the negotiated data channel. The
test also asserts the initiator never asked the shell for a runtime owner,
because the remote device owns the runtime.

## Why this shape, and not a CA in the protocol

The trust rule is documented and deliberate — `docs/p2p-connections.md` says the
app refuses a server it cannot verify, and the fix belongs on the server — so
nothing about it changed. Measured last round: `helper.Host.configure` reached the
fixture coordinator with system roots and got `p2p.server_unavailable`.

Accepting a TLS CA through `service.configure` was the tempting alternative and
is rejected: it contradicts that documented rule, and any new field is a
payload-shape change, which section 7 of the protocol document says needs a table
version bump and a shell and core released together. `--roots` is additive, is
what a host that administers itself needs anyway (P5's headless `serve`), and is
never passed by the shell, so the shipped app behaves exactly as before. It also
cannot be mistaken for "trust anything": the chain is still verified, against
anchors an operator named.

## Verification

- `cmd/dshkerd`: 3 argument-parser cases (`--roots` alone and with the two roots,
  a repeated flag, a relative value) and 3 loader cases (a real PEM bundle, a
  missing file, a file with no certificates).
- `integration/TestCoreDaemonCompletesAPeerConnection`: the acceptance criterion,
  end to end, in about 1.4 s.
- macOS: `go build`, `go vet` (native and `GOOS=windows`), every unit package and
  the full `integration` suite (262.8 s).
- Windows (Go 1.26.4, real `dshkerd.exe`): `go build`, `go vet`, every unit
  package and all four `TestCoreDaemon*` cases pass — the connection test in
  2.53 s — and the 12-test integration subset passes in 256 s.
- `networking/docs/shell-core-protocol.md` gained a "Core arguments" section: the
  three flags, and the sentence that `--roots` never disables verification and is
  not a shell argument.
