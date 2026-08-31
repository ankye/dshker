# VFS And Resource Layout

The app uses one VFS/resource model for desktop, Web, Node service, package,
and MCP access. Product code may define domain folder conventions, but file
access still goes through VFS roots, refs, catalog records, and permissions.

## Root Model

Use these logical roots consistently:

```text
app-data/        persisted app settings, local indexes, and framework state
projects/        mutable user project folders
imports/         shared imported asset library
assets/          immutable packaged assets shipped with the app
cache/           rebuildable thumbnails, previews, proxies, and parser sidecars
logs/            retained diagnostics and release smoke logs
tmp/             disposable in-progress work
exports/         user export output and package staging
```

Physical locations are host-specific, but renderer, Web, service, and MCP
surfaces should only exchange VFS refs, `vfs://` URIs, resource ids, signed
local URLs, or package ids.

## Project Directory Contract

Project resources live under the `projects` root and use a manifest to describe
their resource folders. A readable default structure is:

```text
projects/<project-id>/
  project.json
  resources/
    source/
    imports/
    generated/
    packages/
  metadata/
    notes/
    manifests/
```

Rules:

- `project.json` stores project identity, schema version, root mappings, and
  catalog id references.
- `resources/source/` stores user-authored or project-owned source files.
- `resources/imports/` stores project-local copies or links created by import
  policy. Shared library imports may stay under the `imports` root and be
  referenced by resource id.
- `resources/generated/` stores user-visible generated outputs that should be
  backed up with the project.
- `resources/packages/` stores package import/export staging when the product
  keeps that staging with the project.
- `metadata/` stores small project-owned records. Large catalog indexes remain
  in the SQLite catalog unless a product requires portable project-local
  metadata.

These folders are conventions over VFS refs. They are not a second storage
API, and app code must not pass raw absolute paths between modules.

Use `createProjectResourceManifest(projectId)` to create the default contract,
`validateProjectResourceManifest(manifest)` before trusting persisted project
metadata, and `createProjectResourceRef(projectId, folder, relativePath)` when
business code needs a resource ref. These helpers keep project resources on the
same VFS/catalog/package/Web/MCP path as imported assets.

## Catalog Contract

The SQLite catalog records:

- resource id, VFS root, relative path, URI, type, size, timestamps, and
  fingerprint
- parser metadata, parser version, dependency groups, and failure state
- tags, ratings, color labels, notes, favorites, collections, and smart-folder
  membership
- derivative cache records for thumbnails, previews, proxies, histograms, and
  sidecars
- import batches, source provenance, package manifests, and scan cursors

The physical tree preserves user-readable organization. The catalog provides
scale, search, duplicate lookup, package validation, Web URLs, and MCP access.

## Movement And Deduplication

Directory moves update affected path prefixes in a transaction. They should not
trigger a full catalog rebuild, hash recomputation for unchanged files, or loss
of tags, parser output, package provenance, or stable resource ids.

Hash duplicate detection is catalog behavior. The default policy reports
duplicates while preserving visible folder structure. Products may add hardlink
or copy-elision behavior only after testing backup, package, export, and
cross-file-system behavior.

## Web, Service, And MCP Access

Electron may use the preload bridge or a custom protocol. Browser/Web surfaces
should use the Node VFS service and signed local URLs. External agents should
use the MCP facade. All three routes must enforce the same VFS permissions,
catalog rules, safe URL handling, and error mapping.

## Startup Rule

Opening the VFS catalog, scanning directories, matching parser plugins,
building thumbnails, importing packages, and starting optional service jobs are
background or idle work. They must not block the first visible app shell.
