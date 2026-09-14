# Task 4.2b — the shell reads and writes the catalog through the core

Date: 2026-09-14
Change: `go-owned-headless-core` (P3, task 4.2, second half)

## What changed

`ManagedInstallationCatalogStore` no longer touches the filesystem. It asks the
core — `electron/main/core/install-catalog.ts` is the client — and the Electron
writer is gone: no atomic replace, no symlink refusal, no readback, no second
implementation of the validation rules. `save` now only checks that what the core
answers is what it asked for, and `load` is one `core.install_catalog_inspect`.

`parseManagedInstallationCatalogValue` is split out of the text parser so the
answer off the private channel is projected through exactly the validator the
shell applied while it owned the file. That is the one place the two
implementations could have drifted, and it still has a single definition.

The location type lost `pathStyle`: the core validates absolute paths with the
platform's own API, which is what the shell's writer did too, so the catalog never
needed a spelling hint. `managedInstallationCatalogFilePath` still takes one,
because it joins a path.

## A shell without a core has no catalog at all

`#port()` refuses with `managed.core_unavailable` rather than falling back to a
second writer. This is D5 applied to the second document, and it surfaces as the
same typed `recovery-required` state the registry produced in 4.1.`main.ts`
starts the core before `initializeDefaultRoots()`, so first-run setup registers its
roots _and_ writes its empty catalog through the core like every later write.

## Evidence

- `electron/main/core/install-catalog.test.ts` (5 cases): the exact payloads the
  client sends (`filePath` alone for inspect, `filePath` plus the whole catalog for
  commit), the answer envelope, validation of the answer through the shell's own
  rules, and a `managed.*` refusal crossing unchanged.
- `electron/main/managed/installation-catalog.test.ts` (5 cases): routing to the
  core, the no-core refusal, and a core that answers with a different document
  reported as `managed.persistence_failed`.
- `service.test.ts` gained a file-backed catalog port beside its registry port, so
  the first-run, re-registration and settings-resolution cases still run the real
  service against a real file.
- The local smoke (`--dshker-smoke`) runs the **first-run** path against a
  disposable root and passed; the catalog it left behind is byte-for-byte the
  document only the Go encoder produces (`"toolchains": []` with Go's two-space
  indent and trailing newline), which is only possible if the shell asked the core
  and the core wrote the file and the shell's readback comparison accepted it.
- `npm run type-check`, `format:check`, `architecture:check` and `npx vitest
--run` (156 files, 1288 tests) pass on macOS.

## Carried forward

- 4.2c: the Git and checkout operations themselves still run in Electron. The
  catalog records their result; the core does not yet clone, register, activate or
  switch, and `git` is not yet a declared refusal family.
- The Windows half of this evidence is recorded with the round that syncs the
  checkout to the box.
