# Task 3.3 — the Linux Secret Service provider

Date: 2026-09-14
Change: `go-owned-headless-core` (P2, task 3.3)

## What changed

`internal/secret` had two real providers and one refusal: Keychain on macOS,
DPAPI on Windows, and `ErrUnavailable` everywhere else, Linux included. Linux now
has a provider, and the refusal is left for the platforms that genuinely have
none (the `!darwin && !windows && !linux` fallback, whose test moved with it).

The provider is libsecret's own command line tool, invoked the way the macOS
provider invokes `security`:

- `secret-tool store --label 'dshkerd <key>' dshkerd key <key>` with the secret on
  **stdin**, never in argv where any process listing could read it.
- `secret-tool lookup dshkerd key <key>` with the secret on **stdout**.
- `secret-tool clear dshkerd key <key>` for delete, where "no such item" is the
  state the caller asked for and therefore a success.

The value is base64 before it reaches the tool, because the tool's channel is
text and a device credential is binary; a trailing newline is trimmed. Nothing is
written below the data root — the keyring owns the items, exactly as on macOS.

Why the tool rather than D-Bus: the build is `CGO_ENABLED=0`, so there is no D-Bus
client in the binary, and adding one is a dependency the core does not otherwise
need. `secret-tool` is the provider's own client and is present wherever a keyring
is. A machine without it has no reachable provider, so `Open` refuses with
`p2p.secret_provider_unavailable` rather than storing anything privately.

## The classification that matters on a headless box

A machine with no desktop session has no session bus, so the tool fails with a
D-Bus message rather than "no such item". Reporting that as a write or read
failure would send an operator looking for a corrupted credential when the real
answer is that this machine cannot hold one. The classifier therefore reads the
tool's own message and reports `p2p.secret_provider_unavailable` for an
unreachable keyring, `p2p.secret_missing` for exit status 1 with nothing on
either stream, and a read or write failure for everything else. Both mutating
operations use it, so a keyring that cannot be reached is the same code whichever
call found out.

## How it is tested where it can be

The logic lives in a file with **no** build tag, with the tool behind a runner
seam, so on this machine (macOS, no secret-tool) the tests still run:

- the invocation is pinned — schema, attribute, label, and the secret's absence
  from argv;
- binary values round-trip through the text channel, with and without the tool's
  trailing newline;
- the five failure classifications, and the two mutating ones.

`store_linux.go` binds that logic to `exec.Command` and defines `Open`;
`store_linux_test.go` is the acceptance sentence on a machine that has a real
keyring — one store writes, a freshly opened one reads back, a deleted item
reports itself missing, and a second delete succeeds — and it skips rather than
fails where there is no Secret Service, because the refusal is already pinned by
the platform-neutral tests.

## The Linux leg of the suite

The Go suite had no CI gate at all: the packaging jobs build and run the core but
never test it, and everything Go had been verified on macOS and on the Windows box
by hand. The `verify` job (ubuntu-latest) now sets up Go and runs
`go vet ./...` and `go test ./internal/... ./cmd/...` — the fixture-backed
`integration` package is excluded because it needs a built coordination server,
which stays an explicit run. A second step installs `libsecret-tools` and
`gnome-keyring`, starts a session bus with `dbus-run-session` and an unlocked
keyring, and runs the Secret Service tests inside it, so the round-trip is
exercised rather than skipped wherever the runner allows it.

## Honest limits

The keyring round-trip has not been run on this machine: there is no Secret
Service here, and a Linux binary cannot execute on macOS. What is verified here is
that the package compiles and passes `go vet` for `GOOS=linux`, that the
classification is pinned by the seam tests, and that the invocation is byte-exact.
The live keyring path is what the new CI step is for, and if the runner cannot
provide a session bus the test skips instead of passing quietly — the skip is
visible in the log.
