# Settings page layout compacting

## Context

The Settings page had two layout issues: appearance rows were excessively tall
(5rem per row for a select + label), and the Launcher tab embedded the full
`ManagedWorkspacesPanel` which rendered its own headers, workspace list, and
create-workspace form inside the settings section — double-heading and nested
card chrome.

## Decision

Appearance rows reduced to 3.5rem min-height, and the DSH port form gap
tightened to match the default section spacing. The panel gained an `embedded`
prop that hides its own section header, workspace section (list + create form),
and root-id line, and switches the root cards to a narrower grid layout. The
Settings page passes `embedded: true` alongside the existing
`showInstallations: false, showPort: false`.

## Consequences

The Launcher tab now shows only the compact appearance pickers and the
registered root paths in a no-chrome list, while the workspace management
surface remains available through the dedicated managed-workspaces route. The
full suite passes (382, +1 for the embedded test).
