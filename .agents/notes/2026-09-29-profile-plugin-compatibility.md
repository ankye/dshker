# Profile plugin compatibility before DSH Web launch

## Decision

The launch log showed `settings.installSection is not a function` immediately
after the Launcher switched to DSH `0.2.0-rc.1`. The installed Web profile
plugins still declared DSH `0.1.x` peer ranges, so the URL was announced even
though plugin content was already broken. The Launcher now reads the selected
core and profile package manifests before a version pointer flip and before a
Web start. A typed `runtime.plugin_incompatible` refusal names the affected
packages; there is no plugin deletion, API shim, or guessed fallback in the
production path.

## Evidence

- `electron/main/managed/profile-compatibility.ts` validates DSH peer ranges
  using prerelease-aware comparator handling.
- `profile-compatibility.test.ts` covers prerelease bounds, alternatives,
  incompatible plugins, and a compatible core.
- A real clean profile launch on port `3099` announced a token URL and returned
  authenticated HTTP 200 with no startup errors.
