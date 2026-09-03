# Settings page redesign (grouped sections)

The Settings page was a bare column: an `h3` + description + a left-bordered
ownership callout, then a loose two-card radio group, a port field, and a button.
It did not match the sectioned-header pattern used elsewhere (e.g. the
Statistics tab) and gave no visual emphasis to the selected port mode.

Redesigned both tabs around a common "settings section" system:

- `.settings-section` pairs a header (title + optional description) with a
  right-hand meta pill and a body of controls. The header has a bottom border,
  mirroring `.usage-statistics-header`.
- The DSH Web section puts the current persisted choice in a pill
  ("固定端口 · 3088" / "自动选择") via a new `portStatus` computed, so the
  running state is visible without opening the form.
- Port mode cards now mark the selected card with an accent border, a tinted
  fill, and a custom radio dot (the native radio is visually hidden but still
  labelled and focusable via `:has(input:focus-visible)`), so selection is not
  colour-only.
- The port field + helper text sit in a `.settings-port-detail` block that
  recedes (`opacity: 0.55`) in auto mode, and the Save action is a right-aligned
  footer (`.settings-section-actions`).
- The Launcher tab reuses the same section chrome for Appearance and for the
  managed-directories panel.

Layout is unchanged in behaviour: same component, same refs, same data-testids
(`settings-dsh-port-input`, `settings-apply-dsh-port`, `settings-theme`,
`settings-language`), same launcher-harness port logic. Only presentation was
rebuilt.

Note on `src/styles/routes.css`: the settings block was replaced in place. The
old `.settings-*` rules were dropped and the new grouped-section styles added
at the tail of the file; the rest of the file was re-verified to still cover the
catalog, source, controller-runtime, and version-action column rules.
