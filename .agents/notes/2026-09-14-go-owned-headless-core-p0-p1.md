# Go-owned headless core, P0 and the core half of P1

Date: 2026-09-14
Change: `openspec/changes/go-owned-headless-core`
Tasks: 1.1, 1.2, 1.3, 2.1 (core half)

## What is now frozen

`networking/docs/shell-core-protocol.md` is the reviewed record of what
`internal/localrpc` already enforces, so the shell half of the channel can be
rewritten without renegotiating the wire. It covers the one-shot stdin
bootstrap, the readiness and authentication lines, the five-field frame
header, the two per-direction bounds (16 in flight, 64 KiB per frame), the
platform endpoint guards, the transport refusal codes, and the method table.

`localrpc.Methods` publishes that table in code at
`localrpc.MethodTableVersion == 1`. `methods_test.go` checks it against the
shipped dispatch in `internal/helper`, `internal/peer` and `internal/core`, so
a renamed method cannot stay published and a published method cannot be
missing from the code.

`internal/localrpc/conformance_test.go` drives a fake parent and a fake core
through bootstrap, one successful call, one refusal (`p2p.invalid_operation`),
the channel still working after a refusal, a callback in the other direction,
a foreign bootstrap version, a foreign frame version, a wrong secret, and a
second unbootstrapped client. The endpoint helper is build-tagged, so the same
scenarios run over a Unix socket and over a Windows named pipe.

## What is now built

`cmd/dshkerd` is the headless core entry point: `--version` prints
`dshkerd/1`, any other argument is `p2p.invalid_arguments`, and with no
arguments it acquires the bootstrap through `localrpc.AcceptMain`, serves the
private endpoint, and exits when the parent channel ends. It never daemonizes.

`internal/core` owns the core method table. It answers `core.version` and
refuses everything else with one of two deliberately different codes:
`p2p.not_implemented` for a method published in table version 1 that this core
does not serve yet, and `p2p.invalid_operation` for a method the table does not
list at all. Without that distinction, a shell calling `devices.list` during
the P2 to P4 port could not tell "your core is older" from "that method is
misspelled".

`networking/integration/dshkerd_process_test.go` builds the real binary and
runs the whole contract against it, including the assertion that the core
exits when its parent channel closes.

## Findings that changed the plan

1. The parent role has **two** methods, not four. `electron/main/p2p/rpc.ts`
   admits exactly `runtime.connect` and `peer.state` (`PeerMainMethod`).
   `runtime.invalidate`, `remote.roots` and `remote.directory` travel from the
   shell into the core. Design decision D7 still holds, because D7 is about
   which process answers them, not who initiates.
2. A `null` payload is `p2p.null_field`, not `p2p.invalid_fields`:
   `protocol.Decode` rejects `null` during duplicate-key analysis, before field
   checks. The contract now lists the whole `protocol` code family.
3. The bootstrap reader consumes stdin until EOF, so the parent must close the
   write end after the record. The contract states this explicitly, because a
   parent that only writes and waits deadlocks before readiness.
4. `internal/runtimebridge/directory_test.go` could not compile off Windows:
   it referenced `syscall.ERROR_PRIVILEGE_NOT_HELD` in a file with no build tag,
   so `go test ./...` failed on macOS before this work and the failure had
   nothing to do with any test result. The helper is now split across a
   `windows` and a `!windows` file.

## Verified mechanism for the macOS credential provider

Design D4 commits to shelling out to `security` with the secret on stdin,
because `CGO_ENABLED=0` rules out the Security framework through cgo. Probed on
macOS before writing any code against it:

```bash
printf '<secret>\n<secret>\n' | security add-generic-password -a <account> -s <service> -U -w
security find-generic-password -a <account> -s <service> -w
security delete-generic-password -a <account> -s <service>
```

Three details that would otherwise be rediscovered painfully:

1. `-w` with **no** value is what makes `security` read stdin. Passing the
   secret as the `-w` argument works too but puts it in `argv`, where any
   process on the machine can read it from `ps`; that is the plaintext path
   D4 forbids.
2. The prompt asks for the secret **twice** ("password data for new item" then
   "retype password for new item"). Writing it once yields "passwords do not
   match" and exit 0, so a naive implementation would appear to succeed while
   storing nothing. The value must be written as two lines.
3. `find-generic-password -w` prints the secret on stdout, which is the
   intended read path, and `add-generic-password` needs `-U` to overwrite an
   existing item instead of failing with "already exists".

## Environment note

The Windows checkout runs Go 1.26.4 with `GOTOOLCHAIN=auto` while `go.mod`
requires go 1.27.0, so the first Windows test run fetches the toolchain. The
real tool paths on that host are
`C:\Users\Administrator\scoop\apps\go\1.26.4\bin\go.exe` and
`C:\Users\Administrator\scoop\apps\git\2.54.0\bin\git.exe`; the scoop
shims fail over SSH, and `scoop\apps\go\current` is a junction that cmd
refuses to resolve from a non-interactive session.

## Not done

The shell half of P1 (tasks 2.3 to 2.5) has not started: Electron main does
not yet spawn `dshkerd`, no renderer operation is proxied, and the core write
path is therefore not reachable from the product. P2 to P6 are untouched.
`internal/core` serves one method, so the shell must keep using `dshker-peer`
for every real operation until P2 moves networking ownership.
