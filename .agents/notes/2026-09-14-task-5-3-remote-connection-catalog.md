# Task 5.3, core half — the remote connection catalog

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 5.3)

## What landed

`internal/remoteconnections` owns `<settings root>/dsh-launcher/remote-connections.json`,
the document that lists the remote computers the Launcher can connect to. It is
the Go half of `electron/main/remote/catalog.ts`, ported rule for rule:

- the same format and version (`dsh-launcher.remote-connections`, 1) and exactly
  that one file name below the Settings root;
- the same strict exact-key decoding at every depth — the record, and each
  connection's five fields — with unknown fields refused rather than dropped;
- the same value grammars: a display name that is already trimmed, 1 to 64 bytes
  and free of control characters; a host of at most 253 bytes that starts and ends
  alphanumerically; a port in 1 to 65535; a user of at most 64 bytes from
  `[A-Za-z0-9_][A-Za-z0-9_.-]*`. The shell expressed "no leading hyphen" with a
  lookahead; Go's RE2 has none, and the leading character classes already forbid
  it, so the language is identical;
- the same version 4 uuid identity grammar, case-insensitively, and the same
  case-folded display-name uniqueness;
- the same `configRevision`: sha256 of `JSON.stringify([id, name, host, port,
user])`. That string is a contract rather than an implementation detail — the
  page uses it to refuse an edit prepared against another version of the record —
  so the test asserts the two revisions the TypeScript encoder produced;
- the same behaviour on a first read: a missing document is published as an empty
  catalog, because the page is an invitation before it is a document, while a
  document that exists and cannot be understood is still refused;
- the same persistence: a private temporary file in the same directory, an
  atomic rename, a `0600` mode, a sync, and a readback that must parse and match;
  a symbolic link or an unavailable parent directory is `remote.persistence_failed`.

The core publishes `remote.catalog_inspect`, `remote.catalog_create`,
`remote.catalog_update` and `remote.catalog_remove`. Each answers the projected
catalog with every connection's `configRevision`, so the shell keeps the exact
shape it renders today.

## Evidence

- `internal/remoteconnections`: the shell's own bytes are parsed and re-encoded
  identically, with both revisions reproduced (`TestShellGoldenRoundTrips…`); the
  first read publishes an empty catalog; create/update/remove keep the identity
  and refuse a stale revision, an unknown identity, a duplicate name and a second
  remove; fifteen broken documents are refused (not JSON, an array, a top-level or
  entry-level unknown field, a missing field, another format, another version,
  entries not an array, a non-uuid identity, an untrimmed name, a leading-hyphen
  host, port zero, an invalid user, duplicate identities and duplicate names); an
  unsupported version is reported by its own code; the store refuses another file
  name, a relative path, a symbolic link and a missing directory.
- `internal/core`: the four operations over the private channel, including the
  stale-edit refusal and the one-file-name rule.
- `go build`, `go vet` (host and `GOOS=windows`) and the unit suite pass.

## What is left of 5.3

The shell still owns its catalog and its OpenSSH connector. Switching
`RemoteConnectionService` onto these methods and `remote.connect/disconnect`,
then deleting `electron/main/remote`, is the rest of the task — and the point of
it: after that no shell file spawns `ssh`, holds a descriptor, or writes this
document.
