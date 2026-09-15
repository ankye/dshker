# Shell to core private protocol

Version 1. Frozen by the OpenSpec change `go-owned-headless-core`, tasks 1.1
to 1.3. The core process (`dshkerd`, and before it `dshker-peer`) is started as
a child of the shell. This document is the contract between them; it describes
what `internal/localrpc` already enforces, so the shell half can be replaced
without renegotiating the wire.

This is a private, per-user channel. It is not a network API, it is never bound
to TCP, and it never carries a credential to a peer.

## 1. Channels

Exactly three things cross the boundary:

1. one bootstrap record on the child's stdin,
2. one authentication line on a private per-user endpoint,
3. newline-delimited JSON-RPC frames on that same endpoint.

The child writes one readiness line to stdout. No other channel carries control
data: stdout is not a log sink for the protocol, stderr is not parsed, and no
environment variable carries a secret.

## 2. Bootstrap record (stdin, one-shot)

Producer: shell. Consumer: `localrpc.AcceptMain`.

```json
{ "version": 1, "socket": "<absolute endpoint>", "secret": "<64 lowercase hex characters>" }
```

- One JSON object, at most `protocol.MaxControlBytes` (64 KiB) bytes. The
  reader consumes stdin until EOF, so the parent must close the write end after
  writing the record.
- Decoding is strict: an unknown field is rejected, and **every** field must be
  present. Any violation is `p2p.invalid_bootstrap`.
- `version` must be `1`. Any other value is `p2p.invalid_bootstrap`; the child
  never falls back to an older or implied version.
- `secret` must hex-decode to exactly 32 bytes, otherwise `p2p.invalid_bootstrap`.
- Endpoint validation is per platform:

| platform            | accepted endpoint                                                       | guard                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Unix (macOS, Linux) | absolute path whose base name is `peer.sock`                            | parent directory must exist with mode `0700` (`p2p.insecure_socket_directory`); the socket is chmod `0600` after bind (`p2p.insecure_socket`) |
| Windows             | `\\.\pipe\dshker-peer-` followed by exactly 32 lowercase hex characters | DACL `D:P(A;;GA;;;<current user SID>)`; a missing token user is `p2p.helper_user_unavailable`                                                 |

- A rejected endpoint is `p2p.invalid_socket`, a bind failure is
  `p2p.helper_listen_failed`.
- The child then writes exactly `{"version":1,"ready":true}` plus a newline to
  stdout and waits up to 30 s for the single connection. A failure to write
  readiness, or to accept within the window, is `p2p.helper_parent_unavailable`.
- The secret is never persisted, never logged, and is cleared from memory once
  authentication succeeds.

## 3. Authentication line

The first bytes on the accepted endpoint must be one JSON object plus a newline,
delivered within 10 s:

```json
{ "version": 1, "secret": "<the same 64 hex characters>" }
```

- Strict decode, and `version` must be `1`.
- The secret is compared in constant time. Any mismatch closes the connection
  with `p2p.helper_authentication_failed`; the listener is already closed by
  then, so no second attempt is possible.
- On success the child writes `{"version":1,"authenticated":true}` plus a
  newline, clears the read deadline, and treats every later byte as a frame.
- If the shell pipelined a frame directly after the authentication line, those
  bytes are preserved in order and are not lost.
- **Exactly one parent is ever admitted.** `AcceptMain` accepts once and closes
  the listener, so a second client that knows the endpoint but never received
  the bootstrap is refused at connect time. That is the negative case asserted
  by the conformance suite.

## 4. RPC frame header

Both directions, one JSON object per line, at most `protocol.MaxControlBytes`.
Decoding is strict: all five fields are required and an unknown field is
rejected.

```json
{ "version": 1, "id": 1, "method": "devices.list", "payload": {}, "error": "" }
```

| field     | rule                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | must be `1`; any other value terminates the connection                                                                                          |
| `id`      | `1` to `9007199254740991` (2^53-1). Request ids increase strictly per sender; a repeat or a decrease terminates the connection. `0` terminates. |
| `method`  | request: a name from the table in section 6, 1 to 80 characters. response: the empty string                                                     |
| `payload` | the request object, or the success object. `{}` on a refusal                                                                                    |
| `error`   | empty on success, otherwise a named code from section 5                                                                                         |

Response correlation is by `id`. A response whose `id` has no pending call is
dropped, so a timed-out call never becomes another call's result. Request and
response `id` spaces are independent per direction, which is why the core can
call the shell back while a shell call is outstanding.

Limits and lifetimes:

- **16 in-flight requests per direction.** The 17th request is refused with
  `p2p.helper_busy` rather than queued; it is not silently dropped.
- The responder applies a **90 s** deadline to each request and the shell applies
  its own deadline on top.
- A frame that fails to decode, a foreign `version`, a non-increasing `id`, a
  duplicate field, a missing field, or an `error` value that is not a
  well-formed public code (`p2p.` plus lowercase letters, dots and underscores,
  5 to 96 characters) terminates the connection.
- A payload that marshals to `null` is replaced with `{}` and refused as
  `p2p.invalid_result`.

## 5. Refusal codes

A public code is one of the declared families — `p2p.` for the peer vocabulary,
`managed.` and `launcher.` for the Launcher's own management operations, and
`runtime.` for the DSH Web child the core starts, and `remote.` for the SSH
route — followed by lowercase letters, `_` and `.`, at most 96 characters. Anything else
is collapsed to `p2p.operation_failed` before it crosses the boundary, so a shell
never has to interpret an internal error string. The wider set matters because
the core performs operations whose refusals the renderer already maps:
`core.roots_inspect` answers `managed.missing_registry`, `core.install_catalog_inspect`
answers the same code for its own missing file, and collapsing either to a `p2p`
code would leave the user with an unexplained failure. A family that is not
declared is still collapsed, which is what keeps a library's error string from
masquerading as a code.

A code survives the diagnostic wrapped around it. `internal/secret`, for
instance, reports `fmt.Errorf("%w: value too large", ErrWrite)`, whose message
is `p2p.secret_write_failed: value too large`; the refusal is the code and the
sentence is dropped, because a shell can act on the classification but not on a
Win32 or Keychain message. Treating the whole message as opaque collapsed every
wrapped refusal to `p2p.operation_failed`, which hid which store failed.
`protocol.Refusal` is the single rule for this, used by both the private channel
and the session manager — when each spelled it out they disagreed, and the same
wrapped sentinel was classified differently depending on which layer reported it.

Codes owned by the transport itself, which every shell must distinguish:

| code                                | meaning                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p2p.invalid_bootstrap`             | the stdin record is malformed, missing a field, or carries a foreign version                                                                                                |
| `p2p.invalid_socket`                | the endpoint is not the platform's accepted shape                                                                                                                           |
| `p2p.insecure_socket_directory`     | the Unix socket directory is not private (`0700`)                                                                                                                           |
| `p2p.insecure_socket`               | the Unix socket could not be restricted to `0600`                                                                                                                           |
| `p2p.helper_listen_failed`          | the endpoint could not be bound                                                                                                                                             |
| `p2p.helper_user_unavailable`       | the Windows process token has no resolvable user                                                                                                                            |
| `p2p.helper_parent_unavailable`     | readiness could not be published, no parent connected in time, or the channel broke                                                                                         |
| `p2p.helper_authentication_failed`  | the authentication line was malformed, late, or used the wrong secret                                                                                                       |
| `p2p.helper_unavailable`            | the child is gone; the call cannot be delivered                                                                                                                             |
| `p2p.helper_busy`                   | the 16 in-flight slots of that direction are full                                                                                                                           |
| `p2p.helper_failed`                 | the child terminated abnormally                                                                                                                                             |
| `p2p.helper_configuration_required` | the child needs configuration it was not given                                                                                                                              |
| `p2p.null_field`                    | a field or element of the payload is `null` where a value is required                                                                                                       |
| `p2p.missing_field`                 | a required payload field is absent                                                                                                                                          |
| `p2p.duplicate_field`               | a payload object repeats a key, so the payload has no single interpretation                                                                                                 |
| `p2p.invalid_fields`                | the payload is not an object the method schema accepts                                                                                                                      |
| `p2p.invalid_json`                  | the payload or frame is not well-formed JSON                                                                                                                                |
| `p2p.not_implemented`               | the method is published in table version 1 but this composition does not answer it: a core with no peer host, or a published `core.*` method this build has not implemented |
| `p2p.invalid_operation`             | the name is not in the published table, or is a parent-role callback arriving the wrong way                                                                                 |
| `p2p.invalid_request`               | the payload does not satisfy the method's schema                                                                                                                            |
| `p2p.invalid_payload`               | the payload could not be marshalled by the caller                                                                                                                           |
| `p2p.invalid_result`                | the result could not be marshalled by the responder                                                                                                                         |
| `p2p.protocol_mismatch`             | a frame violated the header rules and the connection was closed                                                                                                             |
| `p2p.protocol_limit`                | a frame or control payload exceeded 64 KiB                                                                                                                                  |
| `p2p.operation_failed`              | fallback for a non-public error string                                                                                                                                      |

Operation-level codes are owned by the operation, not by the transport. The
ones the peer already returns and that the shell must keep distinguishable are
`p2p.direct_unavailable`, `p2p.runtime_unavailable`, `p2p.pair_unauthorized`,
`p2p.user_unauthorized`, `p2p.network_revoked`, `p2p.not_connected`,
`p2p.lease_expired`, `p2p.identity_mismatch`, and `p2p.remote_path_forbidden`.
`p2p.peer_offline` belongs to that list too: the coordinator answers it when the
paired computer is not connected, before any path is attempted, and it is a more
actionable answer than a transport failure because the user's next step is to
start that computer. `integration/failure_codes_test.go` drives the real daemon
through authorization, runtime availability and peer presence and asserts three
different codes arrive, none of them the generic fallback.

## 6. Method table version 1

The table is published in code as `localrpc.Methods`, with
`localrpc.MethodTableVersion` equal to `1`, and is checked against the shipped
dispatch by `internal/localrpc/methods_test.go`. Roles name the sender:

- **shell** - the shell sends the request and the core answers.
- **parent** - the core sends the request and the shell answers. These are the
  callbacks the core cannot serve itself.

| group     | methods                                                                                                                                                                                                                                                                                                           | role   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| core      | `core.version`, `core.catalog_commit`, `core.catalog_enable`, `core.catalog_inspect`, `core.catalog_remove_service`, `core.install_catalog_commit`, `core.install_catalog_inspect`, `core.roots_commit`, `core.roots_inspect`, `core.runtime_binding`, `core.secret_delete`, `core.secret_get`, `core.secret_set` | shell  |
| managed   | `managed.checkout_prepare`, `managed.checkout_verify`, `managed.git_register`, `managed.repository_inspect`                                                                                                                                                                                                       | shell  |
| device    | `device.createCSR`, `device.createKey`, `device.enroll`, `device.enrollmentToken`, `device.enrollmentResult`, `device.restore`                                                                                                                                                                                    | shell  |
| directory | `directory.inspect`, `directory.refresh`                                                                                                                                                                                                                                                                          | shell  |
| devices   | `devices.bind`, `devices.list`, `devices.unbind`                                                                                                                                                                                                                                                                  | shell  |
| network   | `network.join`, `network.leave`, `network.invalidate`                                                                                                                                                                                                                                                             | shell  |
| networks  | `networks.create`, `networks.delete`, `networks.deletePair`, `networks.devices`, `networks.limit`, `networks.list`, `networks.pairs`, `networks.rename`                                                                                                                                                           | shell  |
| pairs     | `pairs.action`, `pairs.adopt`, `pairs.identity`, `pairs.invite`, `pairs.list`, `pairs.pin`, `pairs.share`                                                                                                                                                                                                         | shell  |
| peer      | `peer.connect`, `peer.disconnect`                                                                                                                                                                                                                                                                                 | shell  |
| remote    | `remote.connect`, `remote.directory`, `remote.disconnect`, `remote.roots`, `remote.status`                                                                                                                                                                                                                        | shell  |
| runtime   | `runtime.console`, `runtime.invalidate`, `runtime.port_get`, `runtime.port_set`, `runtime.start`, `runtime.status`, `runtime.stop`                                                                                                                                                                                | shell  |
| service   | `service.configure`                                                                                                                                                                                                                                                                                               | shell  |
| user      | `user.current`, `user.login`, `user.logout`, `user.register`                                                                                                                                                                                                                                                      | shell  |
| callback  | `runtime.connect`, `peer.state`, `directory.changed`, `catalog.changed`                                                                                                                                                                                                                                           | parent |

The `core.*` group is the local state the core owns outright: its version, the
device credential store, the device catalog, the managed-root registry (4.1) and
the managed installation catalog (4.2). `core.roots_inspect` and `core.roots_commit` take the registry file path
and the machine's Harness home explicitly, because the core is told where things
are rather than guessing: it owns exactly one file name below the Settings root,
validates the whole topology before writing, publishes atomically, and proves the
published bytes by reading them back. The catalog methods carry the same revision the file has always had — the sha256 of the stored bytes — so the token the shell passes back is the one it computed while it still owned the file. The shell starts the core with `--catalog <settings root>/dsh-launcher`, the exact directory it used to write `p2p-devices.json` itself, so an existing record is adopted in place and the shell stops writing it; on a shell that could not start a core at all, the file path remains the degraded writer. `core.catalog_inspect` answers `{"enabled":false}` for a directory that was never enabled, which is a state the shell renders as an invitation, never as a failure, and a core started without a catalog directory refuses these four methods rather than reporting an empty one.

`directory.inspect` and `directory.refresh` answer the coordinator's device
directory as **one** value per service: the account's own bound devices, and every
network the signed-in account owns with its members. The core is its only owner in
the application. Before this, every page read the coordinator for itself and kept
its own copy, so two machines in one network could each show a snapshot taken at a
different moment and neither ever caught up — a list that says a device "never
reported" is usually a copy that was read before the device reported anything.

`directory.inspect` answers the held snapshot and never touches the network.
`directory.refresh` reads the coordinator first and answers the result. Both answer
`{ "serviceId", "known", "revision", "fetchedAt", "networks": [ { "networkId",
"userId", "name", "maxDevices", "devices": [ ... ] } ], "devices": [ ... ] }`,
where each device row is the coordinator's own `DeviceEntry` (id, account, name,
presence, last seen, reported version, platform and architecture) and `known:
false` with a zero revision means this core holds no snapshot yet — a state the
shell renders as "not read" rather than as an account with no devices. `refresh`
without a user session is `p2p.user_login_required`; any other refusal is the
coordinator's own code.

The snapshot is maintained rather than only read on demand. The core learns the
session from the token the shell already sends with every user and network
operation, so the first such call after a restart brings the list up to date
without a separate handshake; a successful operation that can change who belongs
to a network (`devices.bind`, `devices.unbind`, `network.leave`, `network.join`,
`networks.create`, `networks.delete`, `pairs.adopt`) reads again; and while a
session is known the whole directory is re-read every
`helper.DirectoryMaintenanceInterval` (30s, the coordinator's own last-seen
granularity), keeping the last good snapshot when a read fails. Whenever the
content changes the revision moves and the core sends the parent-role
`directory.changed` callback with `{ "serviceId", "revision" }`, which the shell
forwards to its renderer; a read that found the same devices sends nothing, so a
list that did not change is not re-rendered. Signing out drops the session and the
snapshot together, because one account's devices must never be shown under
another's session.

The catalog of paired computers is maintained the same way, and by the same owner.
Each account reads the coordinator's pairs and every pair's identity on the same
30-second interval, pins each active pair into its peer session, and records the
result as the catalog's computers — the rules the shell used to apply when it did
this work through `pairs.list`, `pairs.identity` and `pairs.pin`. A row the
coordinator no longer carries is recorded as revoked rather than dropped, because
dropping an active computer is what the catalog's transition guard refuses, and a
connection authorized a second time is retired in a commit of its own before it is
recorded again, because the guard refuses reviving a revoked row in one step.
Whenever the record changes the core sends the parent-role `catalog.changed`
callback with `{ "serviceId", "revision" }`, where the revision is the catalog's
own — unchanged when the record did not, so a pass that found the same pairs
announces nothing. This is what removes the last "a page has to open before a newly
paired computer exists" path: `pairs.list`, `pairs.pin` and `pairs.identity` remain
published for the shell's own pairing flows, but nothing has to call them to keep
the computer list current.

`core.install_catalog_inspect` and `core.install_catalog_commit` own the other
document below that same `dsh-launcher` directory,
`managed-installation-catalog.json`. They take its absolute path per call, exactly
as the roots methods do, and `internal/installcatalog` accepts only that one file
name. The answer carries the document's own shape under `catalog`, so the shell
parses it with the validator it used while it owned the file, and a commit
re-validates every toolchain identity, remote identity and revision rule before it
publishes atomically and proves the bytes by reading them back. A missing file is
`managed.missing_registry`, an identity mismatch is `managed.invalid_record` — the
same classifications the shell's own writer and reader produced, which is what
lets the two implementations share one file. Two rules are deliberately
asymmetric on the two paths, and each matches the shell it replaces: a commit whose
`version` or `format` is not this build's is `managed.invalid_record` (the shell's
writer validator said so too), while reading a file another Launcher version wrote
is `managed.unsupported_version`, so the launch can explain the cause instead of
reporting corruption.

The rest of the table is answered by the installed-peer host composed beside the core's own
stores: `dshkerd` creates the same `helper.Host` the peer executable runs, binds the private
channel to it for the two parent-role callbacks, and hands it every published shell-role method
that is not a `core.*` one. That is what lets the shell stop launching a second child, and it is
why `p2p.not_implemented` now means one of two things only: a core started without a peer host at
all (the helperless unit tests), or a published `core.*` method this build has not implemented. A
name that is not in the table is refused as `p2p.invalid_operation` before anything else looks at
it, and an inbound parent-role method is refused the same way, because the core sends those rather
than answers them. `device.createCSR` and `device.createKey` were called by the shell all along but
missing from this table; they are published now, which is additive within version 1 and closes the
gap between the table and the contract it describes.

``managed.checkout_prepare`, `managed.checkout_verify`, `managed.git_register` and
`managed.repository_inspect` are the checkout layer the core took over in 4.2. The
shell asks for one operation and receives a verified identity it persists: the
core pins and version-checks the git executable, derives and proves the managed
paths itself, creates or refreshes the mirror (from the declared URL, or from a
verified bundle), resolves the selection, materializes the detached worktree for
that exact commit, and refuses an activation while the tree is dirty. Every
refusal that leaves these methods is one of the three codes the page already maps
— `managed.git_remote_invalid`, `managed.git_revision_invalid` and
`managed.git_operation_failed` — because the shell's own `git.*` codes are
internal to this composition and are not a refusal family.

`core.runtime_binding` is the reverse-proxy half of hosting, published in 6.1 so a caller
with no display can ask what this machine hands a peer. It answers
`{"generation":N,"url":"http://127.0.0.1:P/?token=..."}` — the loopback address of the
running child and the generation that identifies it — and refuses with
`p2p.runtime_unavailable` when no child is running, which is the same code the desktop
runtime owner reports for a stopped or failed child. The generation advances when the
child is replaced or announces a different address and is stable while it is the same
launch, so a peer that reconnects to an unchanged child is not told its proxy target
moved. The address carries a session credential: it is a main-side value, and this
method is only reachable on the private channel the shell's bootstrap created.

Because a whole record now travels in one frame, its own cap is deliberately smaller than the frame cap: `catalog.MaxRecordBytes` is 60 KiB against the 64 KiB of section 4, leaving room for the envelope of both `core.catalog_inspect` and `core.catalog_commit`. `internal/core/catalog_frame_test.go` pins the relationship, since a record at the frame cap would make the frame writer drop the answer and leave the caller waiting for a reply that can never arrive.

Two findings from writing this table down, both deliberate:

1. The plan for task 1.2 expected **four** parent-role methods. The shipped
   dispatch admits **three** (`runtime.connect`, `peer.state` and
   `directory.changed`, the exact `PeerMainMethod` union in
   `electron/main/p2p/rpc.ts`); a fourth, `catalog.changed`, joined them when the
   core took over the paired-computer catalog. `runtime.invalidate`,
   `remote.roots` and `remote.directory` travel the other way, from the shell
   into the core. Design decision D7 still holds, because D7 is about which
   process answers them, not about who initiates.
2. Per-method **field-level** success and refusal shapes are not guessed here.
   Each method's payload is strictly decoded by its own struct in
   `internal/protocol` and `internal/helper`, and a missing or unknown field is
   `p2p.missing_field` or `p2p.invalid_request`. Field-level shapes are
   enumerated as each method is ported, in phases P2 to P4, so that this
   document never states a contract the code does not enforce.

## 7. Versioning

`MethodTableVersion = 1`. Adding a method is additive within version 1: an older
shell simply never calls it, and an older core refuses it with
`p2p.invalid_operation` instead of guessing. Changing a payload shape or a
refusal code for an existing method requires a new table version plus a shell and
core released together. A foreign bootstrap or frame `version` is always refused,
never downgraded.

## 8. Lifetime

The core is a child of the shell, never a daemon. On shell quit, `SIGTERM`, or a
crashed shell, the core and any `dshker-peer` it started must exit with it
(design decision D6: a Unix process group, a Windows Job Object). The core never
detaches, never writes to the shell's terminal, and never listens on anything
other than the private endpoint above.

One mode has no shell above it: `dshkerd serve` (6.1) is the headless host, for a
machine with no desktop session. It publishes its own endpoint — a `0700` per-user
state directory, the same private endpoint the shell's child creates, and
`core.json` in the shape of the stdin bootstrap written `0600` — and answers every
client that authenticates against it until it is asked to stop. The bootstrap
secret is the same secret; the difference is only who wrote it. The composition is
the one the shell's child has, with one policy of its own: it accepts and drops
`peer.state` because a host with no renderer has nothing to inform, and it answers
the parent-role `runtime.connect` from the child it supervises (see section 6).

## 9. Core arguments

The core takes its state as explicit absolute paths and nothing else. The shell
passes the two roots; a typo fails the boot rather than starting a core with the
wrong state, and every argument is accepted at most once in any order.

| argument          | meaning                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--data <dir>`    | main-owned directory the core persists under; the platform secret store is rooted there                                                     |
| `--catalog <dir>` | directory the core owns the device catalog in. It must already exist, and a core without it refuses the catalog methods instead of guessing |
| `--roots <PEM>`   | extra CA certificates for the coordinator HTTPS connection, on top of the system store                                                      |

`--roots` never disables verification and never weakens it: it names anchors
the operator chose, the same act as installing them in the OS store, and it is
**not** passed by the shell. The product rule stays as documented in the
launcher: a machine that does not already trust the server refuses it, and the
fix is on the server. The flag exists for the headless host of P5 and for the
test suite, which runs a coordinator on a private CA.

The headless host is driven through named subcommands, each of which is sugar over
the same published table: `serve`, `status`, `roots`, `dsh start`, `dsh stop`, `call`,
`pair`, `connect`, `proxy` and `service configure`. `call` reaches any published
method and prints a refusal code verbatim, so every named command can be reproduced
without it. With no subcommand the binary is still the shell's child and bootstraps
from stdin, which is what keeps an installed shell unchanged.

## 10. Conformance

`internal/localrpc/conformance_test.go` drives a fake parent and a fake core
through bootstrap, one successful call, one refusal, a foreign bootstrap version,
and a second unbootstrapped client, on macOS, Linux and Windows.
`internal/localrpc/methods_test.go` checks the table in section 6 against the
shipped dispatch in `internal/helper` and `internal/peer`.
