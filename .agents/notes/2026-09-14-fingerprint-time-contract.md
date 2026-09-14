# The fingerprint time contract, and the shell that broke it

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 4.2 — found while porting the runner)

## What was wrong

Both fingerprint shapes (the Git one in `git/types.ts`, the Node/pnpm one in
`toolchain/types.ts`) carry `modifiedAtMilliseconds` and
`changedAtMilliseconds`, and both were filled from Node's `stat().mtimeMs` /
`ctimeMs` unchanged. Node reports those as a fractional number of milliseconds
wherever the filesystem keeps sub-millisecond timestamps — APFS, ext4 and NTFS
all do; on this machine `package.json` reports `1789354676388.1973`.

The record contract, in the shell's own words, is an integer:
`numericIdentityField` refuses anything that is not `Number.isSafeInteger`
(`installation-catalog.ts`), and the core decodes the same two fields as Go
`int64`. So a registration produced a record its own reader would refuse, and
the core — now the only writer — refused it at the channel:

```
json: cannot unmarshal number 1789354676388.1973 into Go struct field
ToolchainFingerprint.modifiedAtMilliseconds of type int64
```

Reproduced in the shell before the fix: a new assertion on the real
`registerNodeExecutable(process.execPath)` result failed, because the pinned
`modifiedAtMilliseconds` was not a safe integer.

## Why the tests did not see it

The interop golden `installcatalog/testdata/managed-installation-catalog.json` is
captured from the shell's own encoder, which is what makes it valuable — but its
fingerprints are hand-written single-digit numbers (`4`, `9`, `10`, `15`,
`16`). It proves the encoder round-trips a document; it says nothing about the
values a real `stat` hands that encoder. The core's test consumed the golden and
passed, and the shell's tests used the same small integers in their fixtures.

## The fix

Whole milliseconds on both sides, and the shell now rounds where it reads the
stat: `Math.trunc(metadata.mtimeMs)` and `Math.trunc(metadata.ctimeMs)` in
`toolchain/process.ts` (Node and pnpm) and `Math.trunc(metadata.mtimeMs)` in
`git/process.ts` (Git). Truncating rather than rounding keeps every comparison
consistent, because both the write and the read pass through the same function.

Whole milliseconds are ample for what the field is for. It exists to notice that
the file behind a registration was replaced; the device, the inode, the size and
the realpath are pinned alongside it, and a different executable that matched all
four to the millisecond is not a case the launcher has to resolve.

## Evidence

- Shell: `toolchain/process.test.ts` and `git/process.test.ts` now assert that a
  real pin's time fields are safe integers, and that the record still verifies
  against the file after rounding (10 and 25 tests in those files, all green;
  full suite 157 files / 1292 tests).
- Core: `installcatalog/fingerprint_contract_test.go` edits the golden's Git
  fingerprint to a whole millisecond and to a fractional one and requires `Parse`
  to accept the first and refuse the second, so neither side can drift back.
- `go build`, `go vet`, `go test` and the shell's type-check are green.

## What this does not fix

A catalog already written with fractional times cannot be read by either side,
and this change does not add a tolerant read: the two implementations agree on
integers, which is the contract, and a record that violates it is refused rather
than reinterpreted. Such a file has to be re-created by registering the toolchain
again. Leaving a fallback in would have hidden the disagreement instead of
removing it.
